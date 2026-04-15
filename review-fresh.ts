/**
 * Fresh review mode — self-contained while-loop using session.send().
 * Each overseer round gets a full holistic re-review from the anchor point.
 */

import type { Session } from "./session.js";
import type { Status } from "./status.js";
import type { RoundResult, Mode } from "./types.js";

import { StopError } from "./session.js";
import { loadConfig } from "./config.js";
import { parseArgs } from "./context.js";
import { buildReviewOverseerPrompt, buildReviewWorkhorsePrompt } from "./review-workhorse.js";
import { reconstructState } from "./resume.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict, sanitize } from "./verdicts.js";
import { formatDuration, formatTime, createStatusTimer } from "./status.js";

export interface FreshReviewState {
	running: boolean;
	round: number;
	maxRounds: number;
	roundResults: RoundResult[];
	initialRequest: string;
	loopStartedAt: number;
}

export type FreshReview = Mode;

export function createFreshReview(session: Session, status: Status): FreshReview {
	const state: FreshReviewState = {
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
				statusPrefix = `🔧 Round ${round}/${state.maxRounds} · fresh · ${cfg.workhorseModel} fixing`;
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

				const now = Date.now();
				const rrEnd = state.roundResults.find(r => r.round === round);
				if (rrEnd) rrEnd.endedAt = now;
				if (roundStartedAt) session.log(`⏱ Round ${round}: ${formatDuration(now - roundStartedAt)} (${formatTime(roundStartedAt)} → ${formatTime(now)})`);

				// Next overseer turn
				round++;
				state.round = round;
				session.blockTools();
				roundStartedAt = Date.now();

				await session.navigateToAnchor(ctx);
				const cfg2 = loadConfig(ctx.cwd);
				if (!await session.setModel(cfg2.overseerModel, cfg2.overseerThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg2.overseerModel}`, "error");
					break;
				}
				statusPrefix = `🔍 Round ${round}/${state.maxRounds} · fresh · ${cfg2.overseerModel} reviewing`;
				updateStatus(ctx);
				session.log(`[Round ${round}] Overseer: ${cfg2.overseerModel} · mode: fresh · started: ${formatTime(roundStartedAt)}`);

				({ text } = await session.send(buildReviewOverseerPrompt({
					focus,
					round,
					contextPaths,
					workhorseSummaries,
				}), ctx));
			}
		} catch (e) {
			if (!(e instanceof StopError)) throw e;
		} finally {
			cleanup(ctx);
			if (!await session.restoreModel(ctx)) {
				ctx.ui.notify("Could not restore your model — check /loop:cfg", "warning");
			}
			session.unblockTools();
			state.running = false;
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

		session.saveModel(ctx);

		state.round = 1;
		state.maxRounds = cfg.maxRounds;
		state.initialRequest = trimmedArgs || "(no focus specified)";
		state.roundResults = [];
		state.loopStartedAt = Date.now();
		state.running = true;
		roundStartedAt = Date.now();

		session.clearStop();
		status.start();
		session.log(`📝 Request · Started: ${formatTime(state.loopStartedAt)}\n${state.initialRequest}`);
		session.rememberAnchor(ctx, { focus, initialRequest: state.initialRequest, contextPaths, mode: "fresh", cwd: ctx.cwd });
		session.blockEditors();
		statusTimer.start(ctx);
		try {
			ctx.ui.notify("Saving model", "info");
			await ctx.waitForIdle();
			await session.navigateToAnchor(ctx);
			if (!await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx)) {
				ctx.ui.notify(`Model not available: ${cfg.overseerModel}`, "error");
				cleanup(ctx);
				state.running = false;
				return;
			}
			session.blockTools();
			statusPrefix = `🔍 Round 1/${state.maxRounds} · fresh · ${cfg.overseerModel} reviewing`;
			updateStatus(ctx);
			session.log(`[Round 1] Overseer: ${cfg.overseerModel} · mode: fresh · started: ${formatTime(roundStartedAt)}`);

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
			state.running = false;
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
					state.running = false;
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
					state.running = false;
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
			state.running = false;
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
