/**
 * Fresh review mode — self-contained while-loop using session.send().
 * Each overseer round gets a full holistic re-review from the anchor point.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Session } from "./session.js";
import type { Status } from "./status.js";
import type { RoundResult } from "./types.js";

import { StopError, findModel, modelToStr } from "./session.js";
import { loadConfig } from "./config.js";
import { parseArgs, expandContextPaths } from "./context.js";
import { promptSets } from "./prompts.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict, sanitize } from "./verdicts.js";
import { formatDuration, formatTime } from "./status.js";

export interface FreshReviewState {
	phase: "idle" | "reviewing" | "fixing";
	round: number;
	maxRounds: number;
	roundResults: RoundResult[];
	initialRequest: string;
	loopStartedAt: number;
}

export interface FreshReview {
	start(args: string, ctx: any): Promise<void>;
	stop(ctx: any): Promise<void>;
	readonly state: FreshReviewState;
}

function buildOverseerPrompt(p: {
	focus: string;
	round: number;
	contextPaths: string[];
	workhorseSummaries: string[];
}): string {
	const parts = [
		`You are a code overseer. Review the code changes in this repository.`,
		`Focus: ${p.focus}`,
		"",
		"Review the code by reading files and running git commands.",
		"Before giving a verdict, inspect all relevant recent commits and changed files for the requested scope.",
		"Do NOT stop after the first issue — keep checking until you are confident there are no other blocking issues in scope.",
		"If the request spans multiple commits, identify every commit that needs fixing, not just the latest one.",
		"RULES:",
		"- You are the OVERSEER. Do NOT modify, edit, or write any files.",
		"- Only use read and bash. Run git/grep/find/ls via bash.",
		"- Review only the requested target. Ignore unrelated files unless directly relevant.",
		"",
		"For each issue you find:",
		"1. **Commit** — the short SHA that introduced it (run `git log --oneline` to find it)",
		"2. **File and line** — exact location",
		"3. **What's wrong** — be specific, not vague",
		"4. **How to fix it** — concrete suggestion the author can act on immediately",
		"",
		"Separate blocking issues (must fix) from nitpicks (optional).",
		"",
		"End your review with exactly one of:",
		`${V_APPROVED}`,
		`${V_CHANGES}`,
	];

	const ctx = expandContextPaths(p.contextPaths);
	if (ctx) parts.push(ctx);

	if (p.round > 1 && p.workhorseSummaries.length > 0) {
		parts.push(
			"",
			"## Previous rounds",
			"Below is the workhorse's SELF-REPORTED summary. Do NOT trust it. The workhorse may have missed things, introduced new bugs, or only partially fixed issues.",
			"",
			...p.workhorseSummaries,
			"",
			"## YOUR JOB THIS ROUND",
			"You MUST read the actual source files and run git commands before giving a verdict.",
			"A review with zero tool calls is a rubber-stamp — that is unacceptable.",
			"Do a full holistic review — don't limit yourself to prior feedback.",
		);
	}

	return parts.join("\n");
}

export function createFreshReview(pi: ExtensionAPI, session: Session, status: Status): FreshReview {
	const state: FreshReviewState = {
		phase: "idle",
		round: 0,
		maxRounds: 10,
		roundResults: [],
		initialRequest: "",
		loopStartedAt: 0,
	};

	let loopPromise: Promise<void> | null = null;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let statusPrefix = "";
	let originalModelStr = "";
	let originalThinking = "xhigh";
	let focus = "";
	let contextPaths: string[] = [];
	let workhorseSummaries: string[] = [];
	let roundStartedAt = 0;

	function updateStatus(ctx: any): void {
		if (state.phase === "idle") return;
		const now = Date.now();
		if (!statusPrefix) return;
		let line = statusPrefix;
		if (roundStartedAt) line += ` · ⏱ Round ${state.round}: ${formatDuration(now - roundStartedAt)}`;
		if (state.loopStartedAt) line += ` · ⏱ Total: ${formatDuration(status.elapsed())}`;
		ctx.ui.setStatus("loop", line);
	}

	function startStatusTimer(ctx: any): void {
		stopStatusTimer();
		updateStatus(ctx);
		statusTimer = setInterval(() => updateStatus(ctx), 1000);
		if (statusTimer.unref) statusTimer.unref();
	}

	function stopStatusTimer(): void {
		if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
		statusPrefix = "";
	}

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
				state.phase = "reviewing";

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
				state.phase = "fixing";
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
				session.log(`🔧 Workhorse done\n${wSummary}`);

				const now = Date.now();
				const rrEnd = state.roundResults.find(r => r.round === round);
				if (rrEnd) rrEnd.endedAt = now;
				if (roundStartedAt) session.log(`⏱ Round ${round}: ${formatDuration(now - roundStartedAt)} (${formatTime(roundStartedAt)} → ${formatTime(now)})`);

				// Next overseer turn
				round++;
				state.round = round;
				state.phase = "reviewing";
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

				({ text } = await session.send(buildOverseerPrompt({
					focus,
					round,
					contextPaths,
					workhorseSummaries,
				}), ctx));
			}
		} catch (e) {
			if (!(e instanceof StopError)) throw e;
		} finally {
			stopStatusTimer();
			session.restoreEditors();
			status.stop();
			ctx.ui.setStatus("loop", "");

			const model = findModel(originalModelStr, ctx);
			if (model) {
				await pi.setModel(model);
				pi.setThinkingLevel(originalThinking as any);
			}
			const elapsed = status.elapsed();
			if (elapsed > 1000) ctx.ui.notify(`Loop ended. ${formatDuration(elapsed)} elapsed.`, "info");
			state.phase = "idle";
		}
	}

	async function start(args: string, ctx: any): Promise<void> {
		if (state.phase !== "idle") { ctx.ui.notify("Loop already running — /loop:stop to cancel", "warning"); return; }

		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();
		const parsed = parseArgs(trimmedArgs, ctx.cwd);
		focus = parsed.focus;
		contextPaths = parsed.contextPaths;
		workhorseSummaries = [];

		originalModelStr = modelToStr(ctx.model);
		originalThinking = pi.getThinkingLevel();

		state.round = 1;
		state.maxRounds = cfg.maxRounds;
		state.initialRequest = trimmedArgs || "(no focus specified)";
		state.roundResults = [];
		state.loopStartedAt = Date.now();
		state.phase = "reviewing";
		roundStartedAt = Date.now();

		status.start();
		session.log(`📝 Request · Started: ${formatTime(state.loopStartedAt)}\n${state.initialRequest}`);
		session.rememberAnchor(ctx, { focus, initialRequest: state.initialRequest, contextPaths, mode: "review", cwd: ctx.cwd });
		session.blockEditors();
		startStatusTimer(ctx);
		ctx.ui.notify(`Saving model: ${originalModelStr} · ${originalThinking}`, "info");
		await ctx.waitForIdle();
		await session.navigateToAnchor(ctx);
		if (!await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx)) {
			ctx.ui.notify(`Model not available: ${cfg.overseerModel}`, "error");
			stopStatusTimer();
			session.restoreEditors();
			status.stop();
			state.phase = "idle";
			ctx.ui.setStatus("loop", "");
			return;
		}
		statusPrefix = `🔍 Round 1/${state.maxRounds} · fresh · ${cfg.overseerModel} reviewing`;
		updateStatus(ctx);
		session.log(`[Round 1] Overseer: ${cfg.overseerModel} · mode: fresh · started: ${formatTime(roundStartedAt)}`);

		const firstResponse = session.send(buildOverseerPrompt({
			focus,
			round: 1,
			contextPaths,
			workhorseSummaries: [],
		}), ctx);

		loopPromise = processLoop(firstResponse, ctx).catch((e) => {
			if (!(e instanceof StopError)) ctx.ui.notify(`Loop error: ${e.message}`, "error");
		});
	}

	async function stop(ctx: any): Promise<void> {
		if (state.phase === "idle") return;
		session.stop();
		if (loopPromise) await loopPromise;
		const elapsed = status.elapsed();
		if (elapsed > 1000) ctx.ui.notify(`Loop ended. ${formatDuration(elapsed)} elapsed.`, "info");
	}

	return {
		start,
		stop,
		get state() { return state; },
	};
}
