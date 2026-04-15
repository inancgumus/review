/**
 * Exec mode — self-contained while-loop using session.send().
 * Orchestrator drip-feeds steps via <task> tags; workhorse implements one at a time.
 * Supports both fresh (navigate to anchor each round) and incremental (keep overseer context).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Session } from "./session.js";
import type { Status } from "./status.js";
import type { RoundResult } from "./types.js";

import { StopError, findModel, modelToStr } from "./session.js";
import { loadConfig } from "./config.js";
import { parseArgs, expandContextPaths } from "./context.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict, sanitize, CHANGES_STRIP_RE } from "./verdicts.js";
import { formatDuration, formatTime } from "./status.js";

export interface ExecState {
	phase: "idle" | "reviewing" | "fixing";
	round: number;
	maxRounds: number;
	roundResults: RoundResult[];
	initialRequest: string;
	loopStartedAt: number;
}

export interface ExecMode {
	start(args: string, ctx: any): Promise<void>;
	stop(ctx: any): Promise<void>;
	readonly state: ExecState;
}

// ── Prompt builders (module-local) ──────────────────────

function buildOrchestratorPrompt(p: {
	focus: string;
	round: number;
	contextPaths: string[];
	workhorseSummaries: string[];
}): string {
	const parts = [
		"You are an implementation orchestrator. You oversee a plan and direct a workhorse to build it step by step.",
		`Focus: ${p.focus}`,
		"",
		"Read the plan and context files below. Examine the current state of the codebase by reading files and running commands.",
		"",
		"YOUR JOB:",
		"1. VERIFY what has been implemented so far. Read the actual source files. Run tests. Run the build. Check git log. Do NOT skip verification.",
		"2. If the workhorse just attempted a step: read every file they claimed to change. Run tests. If anything is missing, wrong, or broken — reassign the same step with specific feedback on what failed.",
		"3. Only after verifying the current step is FULLY correct, identify the next unimplemented step.",
		"4. Describe EXACTLY what the workhorse should do for this ONE step — file paths, function signatures, behavior, tests.",
		"",
		"RULES:",
		"- You are the ORCHESTRATOR. Do NOT modify, edit, or write any files.",
		"- Only use read and bash. Run git/grep/find/ls/tests via bash.",
		"- Drip-feed ONE step at a time. Never dump multiple steps.",
		"- Do NOT mention future steps, the overall plan, or what comes next. The workhorse must not know the full plan.",
		"- Be specific and actionable. The workhorse should not have to guess.",
		"",
		"## CRITICAL: Use <task> tags",
		"Wrap the current step description in `<task>` tags. ONLY the content inside these tags is sent to the workhorse. Everything outside is stripped.",
		"",
		"Example:",
		"```",
		"I verified step 1 is complete. Tests pass. Moving to step 2.",
		"",
		"<task>",
		"Create `calc.go` with an Add function that takes two int args and returns their sum.",
		"Add a test in `calc_test.go` with table-driven cases for positive, negative, and zero inputs.",
		"</task>",
		"```",
		"",
		"Your notes, verification results, and reasoning stay outside the tags — the workhorse never sees them.",
		"",
		"VERIFICATION CHECKLIST (do this every round):",
		"- Read the files the workhorse changed. Do they match what was asked?",
		"- Run tests/build. Do they pass?",
		"- Check for missing pieces: error handling, edge cases, tests if required.",
		"- A verdict with zero tool calls is a rubber-stamp — that is unacceptable.",
		"",
		"If ALL steps in the plan are correctly implemented AND verified:",
		`${V_APPROVED}`,
		"",
		"If the workhorse needs to do work (implement next step or redo current):",
		`${V_CHANGES}`,
	];

	const ctx = expandContextPaths(p.contextPaths);
	if (ctx) parts.push(ctx);

	if (p.round > 1 && p.workhorseSummaries.length > 0) {
		parts.push(
			"",
			"## Previous rounds",
			"Below is the workhorse's SELF-REPORTED summary. Do NOT trust it. Verify by reading the actual code.",
			"",
			...p.workhorseSummaries,
			"",
			"## YOUR JOB THIS ROUND",
			"You MUST read the actual source files and run tests/build before giving a verdict.",
			"Do NOT trust the summary above. The workhorse may have cut corners, skipped tests, or left broken code.",
			"Verify the last step was implemented correctly, then assign the next step or approve.",
		);
	}

	return parts.join("\n");
}

function buildIncrementalPrompt(round: number): string {
	return [
		`Re-check round ${round}. The workhorse worked on the step you assigned (see the summary above).`,
		"Do NOT trust the summary. Read the actual files. Run tests. Run the build. Verify with your own eyes.",
		"",
		"If the step is done correctly AND tests/build pass, assign the next step.",
		"If anything is missing, wrong, or broken, reassign the same step with specific feedback.",
		"If ALL steps in the plan are complete and verified, approve.",
		"A verdict with zero tool calls is a rubber-stamp — that is unacceptable.",
		"",
		"Wrap the next step in `<task>` tags. Only the content inside the tags is sent to the workhorse.",
		"Your verification notes and reasoning stay outside — the workhorse never sees them.",
		"",
		"End with exactly one of:",
		`${V_APPROVED}`,
		`${V_CHANGES}`,
	].join("\n");
}

function extractTask(text: string): string {
	const match = text.match(/<task>([\s\S]*?)<\/task>/i);
	if (match) return match[1].trim();
	return text;
}

function buildImplementerPrompt(overseerText: string, round: number): string {
	const cleaned = sanitize(extractTask(overseerText).replace(CHANGES_STRIP_RE, "").trim());
	return [
		`## Workhorse Task — Round ${round}`,
		"",
		cleaned,
		"",
		"---",
		"",
		"Implement ONLY the single step the orchestrator described above — nothing more.",
		"- Do NOT implement ahead. Do NOT look at or work on future steps.",
		"- Do NOT delegate to subagents. Do all the work yourself, directly.",
		"- Follow the instructions precisely.",
		"- Run tests if the orchestrator asked you to, or if the project has them.",
		"- When done, stop. The orchestrator will assign the next step.",
		"",
		"### Git rules (mandatory)",
		"- Commit your work: `git add -A && git commit -m \"<descriptive message>\"`",
		"- Use clear, descriptive commit messages that explain what the commit does.",
		"- One commit per step unless the orchestrator says otherwise.",
		"",
		"### CRITICAL: Never open an interactive editor",
		"- NEVER run bare `git rebase -i` — it opens vim/vi and you WILL get stuck.",
		"- Same applies to `git commit` without `-m` or `--no-edit` — always pass a message flag.",
		"",
		"IMPORTANT: Do NOT output any VERDICT lines. You are the workhorse, not the orchestrator.",
		"",
		"When you have completed the work,",
		"end your response with exactly:",
		`${V_FIXES_COMPLETE}`,
	].join("\n");
}

// ── Factory ─────────────────────────────────────────────

export function createExecMode(pi: ExtensionAPI, session: Session, status: Status): ExecMode {
	const state: ExecState = {
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

	// Incremental-specific state
	let overseerLeafId: string | null = null;

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
			const cfg = loadConfig(ctx.cwd);
			const isIncremental = cfg.reviewMode === "incremental";

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

				// Save leaf position for incremental navigation
				if (isIncremental) {
					overseerLeafId = session.getLeafId(ctx);
				}

				// Workhorse turn
				state.phase = "fixing";
				const cfgW = loadConfig(ctx.cwd);

				const rr = state.roundResults.find(r => r.round === round);
				if (rr) rr.workhorseStartedAt = Date.now();

				await session.navigateToAnchor(ctx);
				if (!await session.setModel(cfgW.workhorseModel, cfgW.workhorseThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfgW.workhorseModel}`, "error");
					break;
				}
				statusPrefix = `🔧 Round ${round}/${state.maxRounds} · exec · ${cfgW.workhorseModel} fixing`;
				updateStatus(ctx);
				session.log(`[Round ${round}] Workhorse: ${cfgW.workhorseModel}`);

				const workhorsePrompt = buildImplementerPrompt(text, round);
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

				const cfg2 = loadConfig(ctx.cwd);
				if (!await session.setModel(cfg2.overseerModel, cfg2.overseerThinking, ctx)) {
					ctx.ui.notify(`Model not available: ${cfg2.overseerModel}`, "error");
					break;
				}
				statusPrefix = `🔍 Round ${round}/${state.maxRounds} · exec · ${cfg2.overseerModel} reviewing`;
				updateStatus(ctx);
				session.log(`[Round ${round}] Overseer: ${cfg2.overseerModel} · mode: exec · started: ${formatTime(roundStartedAt)}`);

				if (isIncremental && round > 1 && overseerLeafId) {
					// Incremental: navigate to overseer's leaf and inject workhorse summary
					await session.navigateToEntry(overseerLeafId, ctx);
					pi.sendMessage({ customType: "workhorse-summary", content: summaryText, display: true }, { triggerTurn: false });
					({ text } = await session.send(buildIncrementalPrompt(round), ctx));
				} else {
					// Fresh: navigate to anchor for full re-review
					await session.navigateToAnchor(ctx);
					({ text } = await session.send(buildOrchestratorPrompt({
						focus,
						round,
						contextPaths,
						workhorseSummaries,
					}), ctx));
				}
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
		overseerLeafId = null;

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
		session.rememberAnchor(ctx, { focus, initialRequest: state.initialRequest, contextPaths, mode: "exec", cwd: ctx.cwd });
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
		statusPrefix = `🔍 Round 1/${state.maxRounds} · exec · ${cfg.overseerModel} reviewing`;
		updateStatus(ctx);
		session.log(`[Round 1] Overseer: ${cfg.overseerModel} · mode: exec · started: ${formatTime(roundStartedAt)}`);

		const firstResponse = session.send(buildOrchestratorPrompt({
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
