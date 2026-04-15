/**
 * Incremental review mode — self-contained while-loop using session.send().
 * Overseer keeps context across rounds; workhorse summaries are injected
 * at the leaf position, and patch-id auditing detects unchanged commits.
 */

import type { Session } from "./session.js";
import type { Status } from "./status.js";
import type { RoundResult, Mode } from "./types.js";

import { StopError } from "./session.js";
import { loadConfig } from "./config.js";
import { parseArgs, readContextPaths, snapshotContextHashes, findChangedContextPaths, formatContextMarkdown } from "./context.js";
import { buildReviewOverseerPrompt, buildReviewWorkhorsePrompt } from "./review-workhorse.js";
import { reconstructState } from "./resume.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict, sanitize } from "./verdicts.js";
import { formatDuration, formatTime, createStatusTimer } from "./status.js";
import { git } from "./git.js";

export interface IncrementalReviewState {
	running: boolean;
	round: number;
	maxRounds: number;
	roundResults: RoundResult[];
	initialRequest: string;
	loopStartedAt: number;
}

export type IncrementalReview = Mode;

// ── Incremental re-review prompt (round 2+) ────────────

function buildIncrementalPrompt(round: number, unchangedCommits: string[], changedPaths: string[]): string {
	const parts = [
		`Re-review round ${round}. The workhorse addressed your previous feedback (see the summary above).`,
		"Verify the fixes are correct by reading the changed files and running git commands.",
		"If the author disagreed with a point and explained why, accept it unless it's objectively wrong.",
		"Also check for any new issues introduced by the fixes.",
	];

	if (unchangedCommits.length > 0) {
		parts.push(
			"",
			"## ⚠️ Unchanged commits detected",
			"The following commits were NOT modified by the workhorse (their patch fingerprint is identical to before):",
			...unchangedCommits.map(s => `- **${s}**`),
			"",
			"This is a red flag — the workhorse likely lumped fixes into the wrong commit.",
			"If you tagged these commits with issues, the fixes were NOT applied there.",
			"Re-request fixes for each unchanged commit specifically.",
		);
	}

	if (changedPaths.length > 0) {
		const block = formatContextMarkdown(readContextPaths(changedPaths));
		if (block) {
			parts.push("", "## Updated context files", "The following @path files were modified by the workhorse since your last review:",
				block);
		}
	}

	parts.push(
		"",
		"End with exactly one of:",
		`${V_APPROVED}`,
		`${V_CHANGES}`,
	);

	return parts.join("\n");
}

// ── Factory ─────────────────────────────────────────────

export function createIncrementalReview(session: Session, status: Status): IncrementalReview {
	const state: IncrementalReviewState = {
		running: false,
		round: 0,
		maxRounds: 10,
		roundResults: [],
		initialRequest: "",
		loopStartedAt: 0,
	};

	let loopPromise: Promise<void> | null = null;
	let statusPrefix = "";
	let focus = "";
	let contextPaths: string[] = [];
	let workhorseSummaries: string[] = [];
	let roundStartedAt = 0;

	// Incremental-specific state
	let overseerLeafId: string | null = null;
	let patchSnapshot: Map<string, string> | null = null;
	let snapshotBase = "";
	let taggedCommits: Array<{ sha: string; subject: string }> = [];
	let unchangedCommits: string[] = [];
	let contextHashes: Map<string, string> | null = null;
	let changedContextPaths: string[] = [];

	function updateStatus(ctx: any): void {
		if (!state.running) return;
		if (!statusPrefix) return;
		const now = Date.now();
		let line = statusPrefix;
		if (roundStartedAt) line += ` · ⏱ Round ${state.round}: ${formatDuration(now - roundStartedAt)}`;
		if (state.loopStartedAt) line += ` · ⏱ Total: ${formatDuration(status.elapsed())}`;
		ctx.ui.setStatus("loop", line);
	}

	const statusTimer = createStatusTimer(updateStatus);

	function recordOverseer(round: number, verdict: "approved" | "changes_requested", text: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) { r.verdict = verdict; r.overseerText = text; }
		else state.roundResults.push({ round, verdict, overseerText: text, workhorseSummary: "", startedAt: roundStartedAt, endedAt: 0, workhorseStartedAt: 0 });
	}

	function recordWorkhorse(round: number, summary: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) r.workhorseSummary = summary;
	}

	async function processLoop(responsePromise: Promise<{ text: string }>, ctx: any): Promise<void> {
		try {
			let { text } = await responsePromise;
			let round = state.round;

			while (round <= state.maxRounds) {
				session.blockTools();

				const verdict = matchVerdict(text);

				if (verdict === "approved") {
					recordOverseer(round, "approved", text);
					const now = Date.now();
					const rr = state.roundResults.find(r => r.round === round);
					if (rr) rr.endedAt = now;
					ctx.ui.notify(`✅ Approved after ${round} round(s)`, "success");
					break;
				}

				if (verdict !== "changes_requested") {
					({ text } = await session.send(`Continue. When done, end with ${V_APPROVED} or ${V_CHANGES}`, ctx));
					continue;
				}

				recordOverseer(round, "changes_requested", text);
				const summary = sanitize(stripVerdict(text));
				session.log(`❌ CHANGES REQUESTED\n${summary}`);

				if (round >= state.maxRounds) {
					ctx.ui.notify(`Hit ${state.maxRounds} rounds without approval`, "warning");
					break;
				}

				// Save leaf position after overseer response (for round 2+ navigation)
				overseerLeafId = session.getLeafId(ctx);

				// Snapshot context hashes before workhorse runs
				contextHashes = null;
				changedContextPaths = [];
				if (contextPaths.length > 0) {
					contextHashes = snapshotContextHashes(contextPaths);
				}

				// Snapshot patch-ids before workhorse runs
				patchSnapshot = null;
				snapshotBase = "";
				taggedCommits = [];
				unchangedCommits = [];
				const taggedSHAs = git.extractTaggedSHAs(text);
				if (taggedSHAs.length > 0) {
					const base = git.findSnapshotBase(ctx.cwd, taggedSHAs);
					if (base !== null) {
						patchSnapshot = git.snapshotPatchIds(ctx.cwd, base);
						snapshotBase = base;
						taggedCommits = git.resolveTaggedCommits(ctx.cwd, taggedSHAs);
						session.log(`[Snapshot] ${taggedCommits.length} tagged commits, ${patchSnapshot.size} in range`);
					}
				}

				// Workhorse turn
				session.unblockTools();
				const cfg = loadConfig(ctx.cwd);

				const rr = state.roundResults.find(r => r.round === round);
				if (rr) rr.workhorseStartedAt = Date.now();

				await session.navigateToAnchor(ctx);
				if (!await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg.workhorseModel}`, "error");
					break;
				}
				statusPrefix = `🔧 Round ${round}/${state.maxRounds} · incremental · ${cfg.workhorseModel} fixing`;
				updateStatus(ctx);
				session.log(`[Round ${round}] Workhorse: ${cfg.workhorseModel}`);

				const workhorsePrompt = buildReviewWorkhorsePrompt(text, contextPaths, round, { rewriteHistory: cfg.rewriteHistory });
				let { text: fixText } = await session.send(workhorsePrompt, ctx);

				while (!hasFixesComplete(fixText)) {
					({ text: fixText } = await session.send(`Continue addressing the remaining issues. When all fixes are done, end with ${V_FIXES_COMPLETE}`, ctx));
				}

				const wSummary = sanitize(stripVerdict(fixText));
				const summaryText = `[Workhorse Round ${round}] ${wSummary}`;
				workhorseSummaries.push(summaryText);
				recordWorkhorse(round, summaryText);
				session.appendCompletedRound(round);
				session.log(`🔧 Workhorse done\n${wSummary}`);

				// Compare context snapshots
				if (contextHashes && contextPaths.length > 0) {
					changedContextPaths = findChangedContextPaths(contextPaths, contextHashes);
					if (changedContextPaths.length > 0) {
						session.log(`📄 Changed @paths: ${changedContextPaths.length}/${contextHashes.size}`);
					}
					contextHashes = null;
				}

				// Compare patch-id snapshots
				if (patchSnapshot && taggedCommits.length > 0) {
					const after = git.snapshotPatchIds(ctx.cwd, snapshotBase);
					unchangedCommits = git.detectUnchanged(patchSnapshot, after, taggedCommits);
					if (unchangedCommits.length > 0) {
						session.log(`⚠️ Unchanged commits: ${unchangedCommits.join(", ")}`);
					}
					patchSnapshot = null;
					snapshotBase = "";
					taggedCommits = [];
				}

				const now = Date.now();
				const rrEnd = state.roundResults.find(r => r.round === round);
				if (rrEnd) rrEnd.endedAt = now;
				if (roundStartedAt) session.log(`⏱ Round ${round}: ${formatDuration(now - roundStartedAt)} (${formatTime(roundStartedAt)} → ${formatTime(now)})`);

				// Next overseer turn
				round++;
				state.round = round;
				session.blockTools();
				roundStartedAt = Date.now();

				const cfg2 = loadConfig(ctx.cwd);
				if (!await session.setModel(cfg2.overseerModel, cfg2.overseerThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg2.overseerModel}`, "error");
					break;
				}
				statusPrefix = `🔍 Round ${round}/${state.maxRounds} · incremental · ${cfg2.overseerModel} reviewing`;
				updateStatus(ctx);
				session.log(`[Round ${round}] Overseer: ${cfg2.overseerModel} · mode: incremental · started: ${formatTime(roundStartedAt)}`);

				// Navigate to overseer's leaf and inject workhorse summary
				if (overseerLeafId) {
					await session.navigateToEntry(overseerLeafId, ctx);
					session.sendCustomMessage({ customType: "workhorse-summary", content: summaryText, display: true });
				}

				({ text } = await session.send(buildIncrementalPrompt(round, unchangedCommits, changedContextPaths), ctx));
			}
		} catch (e) {
			if (!(e instanceof StopError)) throw e;
		} finally {
			cleanup(ctx);
			if (!await session.restoreModel(ctx)) {
				ctx.ui.notify("Could not restore your model — check /loop:cfg", "warning");
			}
			session.unblockTools(); state.running = false;
		}
	}

	async function start(args: string, ctx: any): Promise<void> {
		if (state.running) { ctx.ui.notify("Loop already running — /loop:stop to cancel", "warning"); return; }

		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();
		const parsed = parseArgs(trimmedArgs, ctx.cwd);
		focus = parsed.focus;
		contextPaths = parsed.contextPaths;
		workhorseSummaries = [];
		overseerLeafId = null;
		unchangedCommits = [];
		changedContextPaths = [];

		session.saveModel(ctx);

		state.round = 1;
		state.maxRounds = cfg.maxRounds;
		state.initialRequest = trimmedArgs || "(no focus specified)";
		state.roundResults = [];
		state.loopStartedAt = Date.now();
		state.running = true;
		session.blockTools();
		roundStartedAt = Date.now();

		session.clearStop();
		status.start();
		session.log(`📝 Request · Started: ${formatTime(state.loopStartedAt)}\n${state.initialRequest}`);
		session.rememberAnchor(ctx, { focus, initialRequest: state.initialRequest, contextPaths, mode: "incremental", cwd: ctx.cwd });
		session.blockEditors();
		statusTimer.start(ctx);
		try {
			ctx.ui.notify("Saving model", "info");
			await ctx.waitForIdle();
			await session.navigateToAnchor(ctx);
			if (!await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx)) {
				ctx.ui.notify(`Model not available: ${cfg.overseerModel}`, "error");
				cleanup(ctx);
				session.unblockTools(); state.running = false;
				return;
			}
			statusPrefix = `🔍 Round 1/${state.maxRounds} · incremental · ${cfg.overseerModel} reviewing`;
			updateStatus(ctx);
			session.log(`[Round 1] Overseer: ${cfg.overseerModel} · mode: incremental · started: ${formatTime(roundStartedAt)}`);

			const firstResponse = session.send(buildReviewOverseerPrompt({
				focus,
				round: 1,
				contextPaths,
				workhorseSummaries: [],
			}), ctx);

			loopPromise = processLoop(firstResponse, ctx).catch((e) => {
				if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
			});
		} catch (e) {
			cleanup(ctx);
			session.unblockTools(); state.running = false;
			if (!(e instanceof StopError)) ctx.ui.notify(`Loop start error: ${(e as Error).message}`, "error");
		}
	}

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
		if (anchor.data?.cwd) ctx.cwd = anchor.data.cwd;
		const recovered = reconstructState(ctx);
		if (!recovered) { ctx.ui.notify("Nothing to resume. Use /loop to start.", "info"); return; }

		const cfg = loadConfig(ctx.cwd);
		focus = anchor.data?.focus ?? recovered.focus;
		contextPaths = Array.isArray(anchor.data?.contextPaths) ? anchor.data.contextPaths : [];
		workhorseSummaries = [];
		overseerLeafId = recovered.overseerLeafId;

		session.saveModel(ctx);

		state.round = recovered.round;
		state.maxRounds = cfg.maxRounds;
		state.initialRequest = anchor.data?.initialRequest ?? (recovered.focus || "(no focus specified)");
		state.roundResults = [];
		state.loopStartedAt = Date.now();
		roundStartedAt = Date.now();
		state.running = true;

		session.clearStop();
		status.start();
		session.blockEditors();
		statusTimer.start(ctx);
		try {
			ctx.ui.notify(`Resuming round ${recovered.round} (${recovered.phase} phase)`, "info");
			await ctx.waitForIdle();

			if (recovered.phase === "workhorse" && recovered.lastOverseerText) {
				session.unblockTools();
				await session.navigateToAnchor(ctx);
				if (!await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg.workhorseModel}`, "error");
					cleanup(ctx);
					session.unblockTools(); state.running = false;
					return;
				}
				const wp = buildReviewWorkhorsePrompt(recovered.lastOverseerText, contextPaths, state.round, { rewriteHistory: cfg.rewriteHistory });
				loopPromise = processLoop(session.send(wp, ctx), ctx).catch((e) => {
					if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
				});
			} else {
				session.blockTools();
				await session.navigateToAnchor(ctx);
				if (!await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg.overseerModel}`, "error");
					cleanup(ctx);
					session.unblockTools(); state.running = false;
					return;
				}
				loopPromise = processLoop(session.send(buildReviewOverseerPrompt({
					focus, round: state.round, contextPaths, workhorseSummaries,
				}), ctx), ctx).catch((e) => {
					if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
				});
			}
		} catch (e) {
			cleanup(ctx);
			session.unblockTools(); state.running = false;
			if (!(e instanceof StopError)) ctx.ui.notify(`Resume error: ${(e as Error).message}`, "error");
		}
	}

	function cleanup(ctx: any): void {
		const elapsed = status.elapsed();
		statusTimer.stop();
		statusPrefix = "";
		session.restoreEditors();
		session.unblockTools();
		status.stop();
		ctx.ui.setStatus("loop", "");
		if (elapsed > 1000) ctx.ui.notify(`Loop ended. ${formatDuration(elapsed)} elapsed.`, "info");
	}

	async function stop(ctx: any): Promise<void> {
		session.stop();
		if (loopPromise) await loopPromise;
		cleanup(ctx);
	}

	return {
		start,
		resume,
		stop,
		isRunning: () => state.running,
		getMaxRounds: () => state.maxRounds,
		setMaxRounds: (n: number) => { state.maxRounds = n; },
		logSnapshot: () => state.initialRequest ? { initialRequest: state.initialRequest, roundResults: state.roundResults, loopStartedAt: state.loopStartedAt } : null,
	};
}
