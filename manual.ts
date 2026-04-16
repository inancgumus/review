/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Self-contained while-loop using session.send(), no engine dependency.
 */

import type { Session } from "./session.js";
import type { Status } from "./status.js";
import type { RoundResult, Mode } from "./types.js";

import { StopError, extractSessionCwd } from "./session.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import type { PlannotatorClient } from "./plannotator.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { readContextPaths, formatContextMarkdown } from "./context.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict, sanitize, CHANGES_STRIP_RE } from "./verdicts.js";
import { formatDuration, createStatusTimer } from "./status.js";

// ── State ───────────────────────────────────────────────

export interface ManualState {
	running: boolean;
	paused: boolean;
	round: number;
	maxRounds: number;
	roundResults: RoundResult[];
	initialRequest: string;
	loopStartedAt: number;
}

export type ManualMode = Mode;

// ── Prompt builders (module-local) ──────────────────────

function buildManualOverseerPrompt(p: { userFeedback: string; commitSha: string; round: number; focus: string }): string {
	const feedback = p.userFeedback || p.focus;
	const sha = p.commitSha || "unknown";

	if (p.round > 1) {
		return [
			`Re-verify round ${p.round}. The workhorse attempted fixes again.`,
			"Check if your previous concerns were addressed.",
			"",
			`The user reviewed commit ${sha} and gave this feedback:`,
			feedback,
			"",
			"Do NOT add your own issues. Do NOT review beyond the user's feedback.",
			"",
			"End with exactly one of:",
			V_APPROVED,
			V_CHANGES,
		].join("\n");
	}

	return [
		"You are verifying that the workhorse correctly addressed the user's feedback.",
		"",
		`The user reviewed commit ${sha} and gave this feedback:`,
		feedback,
		"",
		"Your ONLY job: did the workhorse do what the user asked? Check each point.",
		"Do NOT add your own issues. Do NOT review beyond the user's feedback.",
		"Read the files, run git commands, verify each point was addressed.",
		"",
		"End with exactly one of:",
		V_APPROVED,
		V_CHANGES,
	].join("\n");
}

function buildManualWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number): string {
	let sha = "";
	let feedbackText = overseerText;
	const commitMatch = overseerText.match(/^\[COMMIT:([^\]]+)\]\n?/);
	if (commitMatch) {
		sha = commitMatch[1];
		feedbackText = overseerText.slice(commitMatch[0].length);
	}

	const cleaned = sanitize(feedbackText.replace(CHANGES_STRIP_RE, "").trim());

	const parts = [
		`## Fix Issues — Round ${round}`,
		"",
	];

	if (sha) {
		parts.push(`Fix the issues on commit ${sha} described below.`);
	} else {
		parts.push("Fix the issues described below.");
	}

	parts.push(
		"",
		cleaned,
		"",
		"---",
		"",
		"Address every issue listed above.",
		"",
		"### Git rules (mandatory)",
	);

	if (sha) {
		parts.push(
			`The commit under review is \`${sha}\`.`,
			`1. Read it with \`git show ${sha}\``,
			"2. Fix the issues",
			`3. If the commit is HEAD: \`git add -A && git commit --amend --no-edit\``,
			"4. If not HEAD:",
			`   - Stage only the affected files: \`git add <files>\``,
			`   - Create a fixup commit: \`git commit --fixup=${sha}\``,
			`   - Autosquash rebase: \`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${sha}~1\``,
		);
	} else {
		parts.push(
			"The commit under review is referenced in the feedback above.",
			"- If the commit is HEAD: `git add -A && git commit --amend --no-edit`",
			"- If not HEAD: `git add <files> && git commit --fixup=<sha>` then `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <sha>~1`",
		);
	}

	parts.push(
		"",
		"### CRITICAL: Never open an interactive editor",
		"- ALWAYS prefix `git rebase -i` with `GIT_SEQUENCE_EDITOR=true` (to auto-accept) or `GIT_SEQUENCE_EDITOR=\"sed ...\"` (to script edits).",
		"- NEVER run bare `git rebase -i` — it opens vim/vi and you WILL get stuck.",
		"- Same applies to `git commit` without `-m` or `--no-edit` — always pass a message flag.",
		"",
		"IMPORTANT: Do NOT output any VERDICT lines. You are the workhorse, not the overseer.",
		"",
		"When you have addressed ALL issues (fixed or explained why you disagree),",
		"end your response with exactly:",
		V_FIXES_COMPLETE,
	);

	const block = formatContextMarkdown(readContextPaths(contextPaths));
	if (block) parts.push(block);

	return parts.join("\n");
}

// ── Factory ─────────────────────────────────────────────

export interface ManualModeOpts {
	reviewFn?: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string };
	plannotator?: PlannotatorClient;
}

export function createManualMode(session: Session, status: Status, opts?: ManualModeOpts): ManualMode {
	const state: ManualState = {
		running: false,
		paused: false,
		round: 0,
		maxRounds: 10,
		roundResults: [],
		initialRequest: "",
		loopStartedAt: 0,
	};

	let loopPromise: Promise<void> | null = null;
	let statusPrefix = "";
	let savedUserEditor: string | undefined;
	let commitList: string[] = [];
	let currentCommitIdx = 0;
	let focus = "";
	let contextPaths: string[] = [];
	let overseerLeafId: string | null = null;

	const reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = opts?.reviewFn ?? reviewCommitInEditor;
	const plannotator = opts?.plannotator ?? null;

	// ── Git recovery ────────────────────────────────

	function recoverGitState(ctx: any): boolean {
		const gitIssue = git.checkGitState(ctx.cwd);
		if (!gitIssue) return true;
		const fixed = git.fixGitState(ctx.cwd, gitIssue);
		if (fixed) return true;
		if (gitIssue.type === "dirty_tree") return true;
		ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually, then /loop:resume`, "error");
		return false;
	}

	// ── Commit resolution ───────────────────────────

	function isRangeArg(arg: string): boolean {
		return arg.includes("..");
	}

	async function pickSingleCommit(ctx: any): Promise<string | null> {
		let range: string;
		try { range = git.resolveRange(ctx.cwd, ""); } catch { range = "HEAD~50..HEAD"; }

		const branchShas = git.listCommits(ctx.cwd, range);
		if (branchShas.length === 0) { ctx.ui.notify("No commits on this branch", "error"); return null; }

		const items = branchShas.map(s => `${s.slice(0, 7)} ${git.getCommitSubject(ctx.cwd, s)}`);
		const picked = await ctx.ui.select("Pick a commit to review", items);
		if (!picked) return null;
		const idx = items.indexOf(picked);
		return idx >= 0 ? branchShas[idx] : null;
	}

	// ── Status ──────────────────────────────────────

	function updateStatus(ctx: any): void {
		if (!state.running) return;
		if (!statusPrefix) return;
		let line = statusPrefix;
		if (state.loopStartedAt) {
			if (state.paused) {
				line += ` · ⏸ Total: ${formatDuration(status.elapsed())}`;
			} else {
				line += ` · ⏱ Total: ${formatDuration(status.elapsed())}`;
			}
		}
		ctx.ui.setStatus("loop", line);
	}

	const statusTimer = createStatusTimer(updateStatus);

	function recordOverseer(round: number, verdict: "approved" | "changes_requested", text: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) { r.verdict = verdict; r.overseerText = text; }
		else state.roundResults.push({ round, verdict, overseerText: text, workhorseSummary: "", startedAt: Date.now(), endedAt: 0, workhorseStartedAt: 0 });
	}

	function recordWorkhorse(round: number, summary: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) { r.workhorseSummary = summary; r.workhorseStartedAt = r.workhorseStartedAt || Date.now(); }
		else state.roundResults.push({ round, verdict: "changes_requested", overseerText: "", workhorseSummary: summary, startedAt: Date.now(), endedAt: 0, workhorseStartedAt: Date.now() });
	}

	// ── Cleanup ─────────────────────────────────────

	async function doCleanup(ctx: any): Promise<void> {
		const wasRunning = state.running;

		if (wasRunning) {
			const gitIssue = git.checkGitState(ctx.cwd);
			if (gitIssue && !git.fixGitState(ctx.cwd, gitIssue) && gitIssue.type !== "dirty_tree") {
				ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually`, "warning");
			}
		}

		status.resume();
		statusTimer.stop();
		statusPrefix = "";
		overseerLeafId = null;
		loopPromise = null;
		ctx.ui.setStatus("loop", "");
		session.restoreEditors();
		if (!await session.restoreModel(ctx)) {
			ctx.ui.notify("Could not restore model", "error");
		}
		const elapsed = status.elapsed();
		status.stop();
		if (elapsed > 1000) ctx.ui.notify(`Loop ended. ${formatDuration(elapsed)} elapsed.`, "info");
		session.unblockTools(); state.running = false; state.paused = false;
	}

	// ── Setup state ─────────────────────────────────

	function setupState(cfg: {
		focus: string;
		initialRequest: string;
		contextPaths: string[];
		maxRounds: number;
		commits: string[];
		startIdx: number;
		pauseTimer?: boolean;
	}, ctx: any): boolean {
		if (state.running) {
			ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning");
			return false;
		}
		session.saveModel(ctx);

		state.running = true;
		session.unblockTools(); state.paused = true;
		state.round = 0;
		state.maxRounds = cfg.maxRounds;
		state.initialRequest = cfg.initialRequest;
		state.roundResults = [];
		state.loopStartedAt = Date.now();

		focus = cfg.focus;
		contextPaths = cfg.contextPaths;
		commitList = cfg.commits;
		currentCommitIdx = cfg.startIdx;

		session.clearStop();
		status.start();
		savedUserEditor = process.env.EDITOR || process.env.VISUAL;
		session.blockEditors();
		session.rememberAnchor(ctx, {
			mode: "manual", focus, initialRequest: state.initialRequest,
			contextPaths, cwd: ctx.cwd,
			commitList, currentCommitIdx,
		});

		if (cfg.pauseTimer) status.pause();
		statusTimer.start(ctx);
		return true;
	}

	// ── First workhorse kickoff (awaited in start/resume) ──

	async function kickoffFirstWorkhorse(
		userFeedback: string,
		commitSha: string | undefined,
		ctx: any,
	): Promise<{ send: Promise<{ text: string }> }> {
		status.resume();
		state.round = 1;
		session.unblockTools(); state.paused = false;
		overseerLeafId = session.getLeafId(ctx);
		if (!await session.navigateToAnchor(ctx)) {
			ctx.ui.notify("No loop anchor found", "error");
			throw new StopError();
		}
		const cfg = loadConfig(ctx.cwd);
		if (!await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx)) {
			ctx.ui.notify(`Model not available: ${cfg.workhorseModel}`, "error");
			throw new StopError();
		}
		statusPrefix = `🔧 Round 1/${state.maxRounds} · ${cfg.workhorseModel} fixing`;
		updateStatus(ctx);

		const text = commitSha ? `[COMMIT:${commitSha}]\n${userFeedback}` : userFeedback;
		return { send: session.send(buildManualWorkhorsePrompt(text, contextPaths, 1), ctx) };
	}

	// ── Inner loop ──────────────────────────────────

	async function innerLoop(
		firstSend: Promise<{ text: string }> | null,
		userFeedback: string,
		commitSha: string | undefined,
		ctx: any,
	): Promise<void> {
		let round = state.round;
		const workhorseSummaries: string[] = [];
		let currentWorkhorseText = commitSha ? `[COMMIT:${commitSha}]\n${userFeedback}` : userFeedback;

		while (round <= state.maxRounds) {
			// ── Workhorse turn ──
			let fixText: string;
			if (firstSend) {
				({ text: fixText } = await firstSend);
				firstSend = null;
			} else {
				session.unblockTools(); state.paused = false;
				overseerLeafId = session.getLeafId(ctx);
				if (!await session.navigateToAnchor(ctx)) {
					ctx.ui.notify("No loop anchor found", "error");
					return;
				}
				const cfg = loadConfig(ctx.cwd);
				if (!await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg.workhorseModel}`, "error");
					return;
				}
				statusPrefix = `🔧 Round ${round}/${state.maxRounds} · ${cfg.workhorseModel} fixing`;
				updateStatus(ctx);
				({ text: fixText } = await session.send(buildManualWorkhorsePrompt(currentWorkhorseText, contextPaths, round), ctx));
			}

			while (!hasFixesComplete(fixText)) {
				({ text: fixText } = await session.send(`Continue addressing the remaining issues. When all fixes are done, end with ${V_FIXES_COMPLETE}`, ctx));
			}

			const summary = sanitize(stripVerdict(fixText));
			const summaryText = `[Workhorse Round ${round}] ${summary}`;
			workhorseSummaries.push(summaryText);
			recordWorkhorse(round, summaryText);

			// ── Overseer turn ──
			session.blockTools(); state.paused = false;
			const cfg2 = loadConfig(ctx.cwd);
			if (!await session.setModel(cfg2.overseerModel, cfg2.overseerThinking, ctx)) {
				ctx.ui.notify(`Model not available: ${cfg2.overseerModel}`, "error");
				return;
			}

			if (round > 1 && overseerLeafId) {
				await session.navigateToEntry(overseerLeafId, ctx);
				session.sendCustomMessage({ customType: "workhorse-summary", content: summaryText, display: true });
			}

			statusPrefix = `🔍 Round ${round}/${state.maxRounds} · ${cfg2.overseerModel} reviewing`;
			updateStatus(ctx);

			let { text: reviewText } = await session.send(buildManualOverseerPrompt({
				userFeedback,
				commitSha: commitSha || "unknown",
				round,
				focus,
			}), ctx);

			// Verdict loop
			let gotVerdict = false;
			while (!gotVerdict) {
				const verdict = matchVerdict(reviewText);
				if (verdict === "approved") {
					recordOverseer(round, "approved", reviewText);
					const rr = state.roundResults.find(r => r.round === round);
					if (rr) rr.endedAt = Date.now();
					status.pause();
					return;
				}
				if (verdict === "changes_requested") {
					recordOverseer(round, "changes_requested", reviewText);
					if (round >= state.maxRounds) {
						ctx.ui.notify(`Hit ${state.maxRounds} rounds without approval`, "warning");
						return;
					}
					const rr = state.roundResults.find(r => r.round === round);
					if (rr) rr.endedAt = Date.now();
					currentWorkhorseText = reviewText;
					round++;
					state.round = round;
					gotVerdict = true;
				} else {
					({ text: reviewText } = await session.send(`Continue. When done, end with ${V_APPROVED} or ${V_CHANGES}`, ctx));
				}
			}
		}
	}

	// ── Process loop (background, handles inner loop + commit review continuation) ──

	async function processLoop(
		firstSend: Promise<{ text: string }>,
		userFeedback: string,
		commitSha: string | undefined,
		ctx: any,
	): Promise<void> {
		try {
			// Complete first inner loop (workhorse already sent from start/resume)
			await innerLoop(firstSend, userFeedback, commitSha, ctx);

			// Remap reviewed commit (workhorse may have amended/rebased)
			if (commitSha) {
				const remapped = git.remapCommit(ctx.cwd, commitSha);
				if (remapped === null) {
					commitList.splice(currentCommitIdx, 1);
				} else if (remapped !== commitSha) {
					commitList[currentCommitIdx] = remapped;
				}
			}

			// After inner loop, continue commit review
			while (commitList.length > 0) {
				session.unblockTools(); state.paused = true;
				const sha = commitList[currentCommitIdx];
				if (!sha) break;

				statusPrefix = `Manual: ${sha.slice(0, 7)} (${currentCommitIdx + 1}/${commitList.length})`;
				updateStatus(ctx);

				const result = reviewFn(sha, ctx.cwd, savedUserEditor);
				if (result.approved) {
					if (currentCommitIdx >= commitList.length - 1) {
						ctx.ui.notify(`All ${commitList.length} commit(s) approved`, "success");
						break;
					}
					currentCommitIdx++;
					continue;
				}

				// Another inner loop for next feedback
				const { send: nextW } = await kickoffFirstWorkhorse(result.feedback, sha, ctx);
				await innerLoop(nextW, result.feedback, sha, ctx);

				// Remap after fix
				const remapped = git.remapCommit(ctx.cwd, sha);
				if (remapped === null) {
					commitList.splice(currentCommitIdx, 1);
					if (currentCommitIdx >= commitList.length) break;
					continue;
				}
				if (remapped !== sha) commitList[currentCommitIdx] = remapped;
			}
		} catch (e) {
			if (!(e instanceof StopError)) throw e;
		} finally {
			await doCleanup(ctx);
		}
	}

	// Full commit review loop (used by resume when no firstSend is pre-created)
	async function processCommitReviewLoop(ctx: any): Promise<void> {
		try {
			if (!recoverGitState(ctx)) return;

			while (true) {
				session.unblockTools(); state.paused = true;
				const sha = commitList[currentCommitIdx];
				if (!sha) break;

				statusPrefix = `Manual: ${sha.slice(0, 7)} (${currentCommitIdx + 1}/${commitList.length})`;
				updateStatus(ctx);

				const result = reviewFn(sha, ctx.cwd, savedUserEditor);
				if (result.approved) {
					if (currentCommitIdx >= commitList.length - 1) {
						ctx.ui.notify(`All ${commitList.length} commit(s) approved`, "success");
						break;
					}
					currentCommitIdx++;
					continue;
				}

				const { send: nextW } = await kickoffFirstWorkhorse(result.feedback, sha, ctx);
				await innerLoop(nextW, result.feedback, sha, ctx);

				// Remap after fix
				const remapped = git.remapCommit(ctx.cwd, sha);
				if (remapped === null) {
					commitList.splice(currentCommitIdx, 1);
					if (currentCommitIdx >= commitList.length) break;
					continue;
				}
				if (remapped !== sha) commitList[currentCommitIdx] = remapped;
			}
		} catch (e) {
			if (!(e instanceof StopError)) throw e;
		} finally {
			await doCleanup(ctx);
		}
	}

	// ── Start ───────────────────────────────────────

	function resolveRepoCwd(ctx: any): string {
		const sessionDir = extractSessionCwd(ctx.sessionManager?.getEntries?.());
		return git.gitToplevel(sessionDir || ctx.cwd);
	}

	async function start(args: string, ctx: any): Promise<void> {
		plannotator?.reset();
		ctx.cwd = resolveRepoCwd(ctx);
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// ── Plannotator path ────────────────────────
		if (cfg.plannotator && plannotator?.isAvailable() && !trimmedArgs) {
			if (!setupState({
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds,
				commits: [], startIdx: 0,
			}, ctx)) return;
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await plannotator.openCodeReview(ctx.cwd);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await doCleanup(ctx);
				return;
			}
			if (result.feedback) {
				try {
					const { send: firstSend } = await kickoffFirstWorkhorse(result.feedback, undefined, ctx);
					loopPromise = processLoop(firstSend, result.feedback, undefined, ctx).catch((e) => {
						if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
					});
				} catch (e) {
					if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${(e as Error).message}`, "error");
					await doCleanup(ctx);
				}
			}
			return;
		}

		// ── Editor path ─────────────────────────────
		let commits: string[];

		if (trimmedArgs && isRangeArg(trimmedArgs)) {
			// Range: a..b or a...b
			commits = git.listCommits(ctx.cwd, trimmedArgs);
			if (commits.length === 0) { ctx.ui.notify(`Could not resolve range: ${trimmedArgs}`, "error"); return; }
		} else if (trimmedArgs) {
			const resolved = git.resolveRef(ctx.cwd, trimmedArgs);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${trimmedArgs}`, "error"); return; }
			commits = [resolved];
		} else {
			const picked = await pickSingleCommit(ctx);
			if (!picked) return;
			const resolved = git.resolveRef(ctx.cwd, picked);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${picked}`, "error"); return; }
			commits = [resolved];
		}

		const label = commits.length === 1 ? commits[0].slice(0, 7) : `${commits.length} commits`;
		if (!setupState({
			focus: `manual review: ${label}`,
			initialRequest: `manual review: ${label}`,
			contextPaths: [], maxRounds: cfg.maxRounds,
			commits, startIdx: 0,
			pauseTimer: true,
		}, ctx)) return;

		// Walk commits — approve or start inner loop
		if (!recoverGitState(ctx)) { await doCleanup(ctx); return; }

		while (true) {
			session.unblockTools(); state.paused = true;
			const sha = commitList[currentCommitIdx];
			if (!sha) {
				ctx.ui.notify(`All ${commitList.length} commit(s) approved`, "success");
				await doCleanup(ctx);
				return;
			}

			statusPrefix = `Manual: ${sha.slice(0, 7)} (${currentCommitIdx + 1}/${commitList.length})`;
			updateStatus(ctx);

			const result = reviewFn(sha, ctx.cwd, savedUserEditor);
			if (result.approved) {
				if (currentCommitIdx >= commitList.length - 1) {
					ctx.ui.notify(`All ${commitList.length} commit(s) approved`, "success");
					await doCleanup(ctx);
					return;
				}
				currentCommitIdx++;
				continue;
			}

			// Start first inner loop — kickoff is awaited so status/prompt are ready before start() returns
			try {
				const { send: firstSend } = await kickoffFirstWorkhorse(result.feedback, sha, ctx);
				loopPromise = processLoop(firstSend, result.feedback, sha, ctx).catch((e) => {
					if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
				});
			} catch (e) {
				if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${(e as Error).message}`, "error");
				await doCleanup(ctx);
			}
			return;
		}
	}

	// ── Resume ──────────────────────────────────────

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
		plannotator?.reset();
		ctx.cwd = anchor.data.cwd || resolveRepoCwd(ctx);
		const cfg = loadConfig(ctx.cwd);
		const commits: string[] = Array.isArray(anchor.data.commitList) ? anchor.data.commitList : [];

		// Commit-backed resume
		if (commits.length > 0) {
			for (const sha of commits) {
				if (!git.commitExists(ctx.cwd, sha)) {
					ctx.ui.notify(`Commit ${sha.slice(0, 7)} no longer exists — cannot resume`, "error");
					return;
				}
			}
			const idx = anchor.data.currentCommitIdx ?? 0;
			if (!setupState({
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				commits, startIdx: idx,
			}, ctx)) return;
			ctx.ui.notify(`Resuming manual review — commit ${idx + 1}/${commits.length}`, "info");
			loopPromise = processCommitReviewLoop(ctx).catch((e) => {
				if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
			});
			return;
		}

		// Plannotator-backed resume
		if (!cfg.plannotator || !plannotator?.isAvailable()) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		if (!setupState({
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			commits: [], startIdx: 0,
		}, ctx)) return;
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await plannotator!.openCodeReview(ctx.cwd);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await doCleanup(ctx);
			return;
		}
		if (result.feedback) {
			try {
				const { send: firstSend } = await kickoffFirstWorkhorse(result.feedback, undefined, ctx);
				loopPromise = processLoop(firstSend, result.feedback, undefined, ctx).catch((e) => {
					if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
				});
			} catch (e) {
				if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${(e as Error).message}`, "error");
				await doCleanup(ctx);
			}
		}
	}

	// ── Stop ────────────────────────────────────────

	async function stop(ctx: any): Promise<void> {
		session.stop();
		if (loopPromise) await loopPromise;
		await doCleanup(ctx);
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
