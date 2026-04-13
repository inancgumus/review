/**
 * Loop Extension — automated loop between an overseer and workhorse model.
 *
 * /loop [focus] [@path ...]       — Start review loop
 * /loop:exec [focus] [@path ...]  — Start exec loop (plan orchestrator → workhorse)
 * /loop:manual [range]            — Manual review (you drive, commit by commit)
 * /loop:resume                    — Resume from session state
 * /loop:rounds <n>                — Change max rounds
 * /loop:stop                      — Stop the loop
 * /loop:log                       — Browse verdicts and workhorse summaries
 * /loop:cfg                       — Settings UI
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewMode } from "./types.js";
import { loadConfig, getScopedModels, saveConfigField, THINKING_LEVELS } from "./config.js";
import { createEngine, type Engine } from "./engine.js";
import { showLog } from "./log-view.js";
import { V_APPROVED, V_CHANGES } from "./verdicts.js";
import { newState } from "./types.js";

export default function (pi: ExtensionAPI) {
	const engine = createEngine(pi);

	// Block file-modifying tools (edit, write) when the overseer is reviewing.
	const BLOCKED_TOOLS_DURING_REVIEW = ["edit", "write"];
	pi.on("tool_call", async (event) => {
		if (engine.state.phase !== "reviewing") return;
		if (BLOCKED_TOOLS_DURING_REVIEW.includes(event.toolName)) {
			return { block: true, reason: "You are the OVERSEER — do not edit or write files. Only use read and bash (for git/grep/find/ls). Report issues with file, line, what's wrong, and how to fix." };
		}
	});

	pi.on("agent_end", (_event, ctx) => engine.onAgentEnd(_event, ctx));

	pi.registerCommand("loop", {
		description: "Start loop. Usage: /loop [focus] [@path ...]",
		handler: (args, ctx) => engine.start("review", args, ctx),
	});

	pi.registerCommand("loop:exec", {
		description: "Start exec loop (orchestrator → workhorse). Usage: /loop:exec [focus] [@path ...]",
		handler: (args, ctx) => engine.start("exec", args, ctx),
	});

	pi.registerCommand("loop:manual", {
		description: "Manual review. Usage: /loop:manual [sha]",
		handler: (args, ctx) => engine.startManual(args, ctx),
	});

	pi.registerCommand("loop:resume", {
		description: "Resume loop from session state",
		handler: (_args, ctx) => engine.resume(ctx),
	});

	pi.registerCommand("loop:stop", {
		description: "Stop the loop",
		handler: async (_args, ctx) => {
			if (engine.state.phase === "idle") { ctx.ui.notify("No loop running", "info"); return; }
			ctx.ui.notify("Loop stopped", "info");
			await engine.stop(ctx);
		},
	});

	pi.registerCommand("loop:rounds", {
		description: "Change max rounds: /loop:rounds <n>",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			if (isNaN(num) || num < 1) {
				ctx.ui.notify(`Current max rounds: ${engine.state.phase !== "idle" ? engine.state.maxRounds : loadConfig(ctx.cwd).maxRounds}. Usage: /loop:rounds <n>`, "info");
				return;
			}
			engine.state.maxRounds = num;
			saveConfigField("maxRounds", num);
			if (engine.state.phase !== "idle") ctx.ui.setStatus("loop", `${engine.state.phase === "reviewing" ? "🔍" : "🔧"} Round ${engine.state.round}/${num}`);
			ctx.ui.notify(`Max rounds → ${num}`, "success");
		},
	});

	pi.registerCommand("loop:log", {
		description: "Browse overseer + workhorse logs in a modal viewer",
		handler: async (_args, ctx) => {
			if (engine.state.roundResults.length === 0 && !engine.state.initialRequest) { ctx.ui.notify("No loop rounds recorded yet.", "info"); return; }
			await showLog(engine.state.initialRequest, engine.state.roundResults, ctx, engine.state.loopStartedAt);
		},
	});

	pi.registerCommand("loop:debug", {
		description: "Simulate a 3-round review loop and open the log viewer",
		handler: async (_args, ctx) => {
			seedDemoRounds(engine);
			await showLog(engine.state.initialRequest, engine.state.roundResults, ctx, engine.state.loopStartedAt);
		},
	});

	pi.registerCommand("loop:cfg", {
		description: "View or change loop settings",
		handler: async (_args, ctx) => {
			while (true) {
				const cfg = loadConfig(ctx.cwd);
				const action = await ctx.ui.select("Loop Settings", [
					`Overseer model: ${cfg.overseerModel}`,
					`Overseer thinking: ${cfg.overseerThinking}`,
					`Workhorse model: ${cfg.workhorseModel}`,
					`Workhorse thinking: ${cfg.workhorseThinking}`,
					`Max rounds: ${cfg.maxRounds}`,
					`Loop mode: ${cfg.reviewMode}`,
					`Plannotator: ${cfg.plannotator ? "enabled" : "disabled"}`,
					`Rewrite history: ${cfg.rewriteHistory ? "enabled" : "disabled"}`,
				]);
				if (!action) break;
				if (action.startsWith("Overseer model")) await pickModel("overseerModel", cfg, ctx);
				else if (action.startsWith("Overseer thinking")) await pickThinking("overseerThinking", cfg.overseerThinking, ctx);
				else if (action.startsWith("Workhorse model")) await pickModel("workhorseModel", cfg, ctx);
				else if (action.startsWith("Workhorse thinking")) await pickThinking("workhorseThinking", cfg.workhorseThinking, ctx);
				else if (action.startsWith("Max rounds")) await editMaxRounds(cfg.maxRounds, ctx);
				else if (action.startsWith("Loop mode")) await pickReviewMode(cfg.reviewMode, ctx);
				else if (action.startsWith("Plannotator")) {
					const newVal = !cfg.plannotator;
					saveConfigField("plannotator", newVal as any);
					engine.state.hasPlannotator = null;
					ctx.ui.notify(`Plannotator → ${newVal ? "enabled" : "disabled"}`, "success");
				}
				else if (action.startsWith("Rewrite history")) {
					const newVal = !cfg.rewriteHistory;
					saveConfigField("rewriteHistory", newVal as any);
					ctx.ui.notify(`Rewrite history → ${newVal ? "enabled" : "disabled"}`, "success");
				}
			}
		},
	});

	async function pickModel(field: "overseerModel" | "workhorseModel", cfg: ReturnType<typeof loadConfig>, ctx: any): Promise<void> {
		const models = getScopedModels(ctx.cwd);
		if (models.length === 0) { ctx.ui.notify("No enabledModels in settings.json", "error"); return; }
		const current = cfg[field];
		const picked = await ctx.ui.select(`Select ${field === "overseerModel" ? "overseer" : "workhorse"} model`,
			models.map(m => m === current ? `${m}  ✓` : m));
		if (!picked) return;
		const model = picked.replace(/\s+✓$/, "");
		if (model !== current) { saveConfigField(field, model); ctx.ui.notify(`${field} → ${model}`, "success"); }
	}

	async function editMaxRounds(current: number, ctx: any): Promise<void> {
		const val = await ctx.ui.input("Max rounds", String(current));
		const num = val ? parseInt(val, 10) : NaN;
		if (!isNaN(num) && num > 0 && num !== current) { saveConfigField("maxRounds", num); ctx.ui.notify(`Max rounds → ${num}`, "success"); }
	}

	async function pickThinking(field: "overseerThinking" | "workhorseThinking", current: string, ctx: any): Promise<void> {
		const picked = await ctx.ui.select(`Select thinking level`,
			THINKING_LEVELS.map(l => l === current ? `${l}  ✓` : l));
		if (!picked) return;
		const level = picked.replace(/\s+✓$/, "");
		if (level !== current) { saveConfigField(field, level); ctx.ui.notify(`${field} → ${level}`, "success"); }
	}

	async function pickReviewMode(current: ReviewMode, ctx: any): Promise<void> {
		const picked = await ctx.ui.select("Loop mode", [
			`fresh${current === "fresh" ? "  ✓" : ""}  — clean overseer each round, holistic re-review`,
			`incremental${current === "incremental" ? "  ✓" : ""}  — overseer keeps context, only gets workhorse summary`,
		]);
		if (!picked) return;
		const mode = picked.split(/\s/)[0] as ReviewMode;
		if (mode !== current) { saveConfigField("reviewMode", mode); ctx.ui.notify(`Loop mode → ${mode}`, "success"); }
	}
}

// ── Demo data for /loop:debug ───────────────────────────

import type { RoundResult } from "./types.js";

function seedDemoRounds(engine: Engine): void {
	const rounds: Array<{ overseer: string; verdict: RoundResult["verdict"]; workhorse: string }> = [
		{
			overseer: "## Critical Issues\n\nRace condition in `handleConn()`, error swallowed silently, missing context propagation, missing `defer conn.Close()`.\n\n" + V_CHANGES,
			verdict: "changes_requested",
			workhorse: "Added sync.RWMutex, propagated error, threaded context, added defer conn.Close(). New tests added.",
		},
		{
			overseer: "## Improvements needed\n\nLock granularity too coarse. Deprecated error wrapping.\n\n" + V_CHANGES,
			verdict: "changes_requested",
			workhorse: "Narrowed lock scope. Switched to fmt.Errorf. Removed pkg/errors. 3.2x throughput improvement.",
		},
		{
			overseer: "## Final review\n\nAll issues resolved. Ship it.\n\n" + V_APPROVED,
			verdict: "approved",
			workhorse: "",
		},
	];

	const now = Date.now();
	const durations = [18 * 60000, 12 * 60000, 7 * 60000];
	let elapsed = 0;
	for (const d of durations) elapsed += d;

	const results: RoundResult[] = [];
	let cursor = now - elapsed;
	for (let i = 0; i < rounds.length; i++) {
		const r = rounds[i];
		const workhorseSummary = r.workhorse ? `[Workhorse Round ${i + 1}] ${r.workhorse}` : "";
		results.push({
			round: i + 1,
			verdict: r.verdict,
			overseerText: r.overseer,
			workhorseSummary,
			startedAt: cursor,
			endedAt: cursor + durations[i],
			workhorseStartedAt: r.workhorse ? cursor + Math.floor(durations[i] * 0.4) : 0,
		});
		cursor += durations[i];
	}

	engine.state = newState({
		initialRequest: "fix race condition in connection handler @internal/server/conn.go",
		loopStartedAt: now - elapsed,
		roundResults: results,
		round: rounds.length,
	});
}
