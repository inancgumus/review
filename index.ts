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
import { createSession } from "./session.js";
import { createStatus } from "./status.js";
import { createFreshReview } from "./review-fresh.js";
import { createIncrementalReview } from "./review-incremental.js";
import { createExecMode } from "./exec.js";
import { createManualMode } from "./manual.js";
import { showLog } from "./log-view.js";
import { buildDemoData } from "./demo.js";

export { showLog, loadPiAgent } from "./log-view.js";
export { loadConfig, saveConfigField } from "./config.js";

export default function (pi: ExtensionAPI) {
	const session = createSession(pi);
	const status = createStatus();
	const fresh = createFreshReview(pi, session, status);
	const incremental = createIncrementalReview(pi, session, status);
	const exec = createExecMode(pi, session, status);
	const manual = createManualMode(pi, session, status);

	// Block file-modifying tools (edit, write) when the overseer is reviewing.
	const BLOCKED_TOOLS_DURING_REVIEW = ["edit", "write"];
	pi.on("tool_call", async (event) => {
		const reviewing = fresh.state.phase === "reviewing" || incremental.state.phase === "reviewing" || exec.state.phase === "reviewing" || manual.state.phase === "reviewing";
		if (!reviewing) return;
		if (BLOCKED_TOOLS_DURING_REVIEW.includes(event.toolName)) {
			return { block: true, reason: "You are the OVERSEER — do not edit or write files. Only use read and bash (for git/grep/find/ls). Report issues with file, line, what's wrong, and how to fix." };
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		session.notifyAgentEnd(_event, ctx);
	});

	pi.registerCommand("loop", {
		description: "Start loop. Usage: /loop [focus] [@path ...]",
		handler: (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (cfg.reviewMode === "fresh") return fresh.start(args, ctx);
			return incremental.start(args, ctx);
		},
	});

	pi.registerCommand("loop:exec", {
		description: "Start exec loop (orchestrator → workhorse). Usage: /loop:exec [focus] [@path ...]",
		handler: (args, ctx) => exec.start(args, ctx),
	});

	pi.registerCommand("loop:manual", {
		description: "Manual review. Usage: /loop:manual [sha]",
		handler: (args, ctx) => manual.start(args, ctx),
	});

	pi.registerCommand("loop:resume", {
		description: "Resume loop from session state",
		handler: async (_args, ctx) => {
			const anchor = session.findAnchor(ctx);
			if (anchor?.data?.mode === "manual") {
				await manual.resume(ctx, anchor);
				return;
			}
			ctx.ui.notify("Nothing to resume. Use /loop to start.", "info");
			return;
		},
	});

	pi.registerCommand("loop:stop", {
		description: "Stop the loop",
		handler: async (_args, ctx) => {
			if (fresh.state.phase !== "idle") {
				ctx.ui.notify("Loop stopped", "info");
				await fresh.stop(ctx);
			} else if (incremental.state.phase !== "idle") {
				ctx.ui.notify("Loop stopped", "info");
				await incremental.stop(ctx);
			} else if (exec.state.phase !== "idle") {
				ctx.ui.notify("Loop stopped", "info");
				await exec.stop(ctx);
			} else if (manual.state.phase !== "idle") {
				ctx.ui.notify("Loop stopped", "info");
				await manual.stop(ctx);
			} else {
				ctx.ui.notify("No loop running", "info");
			}
		},
	});

	pi.registerCommand("loop:rounds", {
		description: "Change max rounds: /loop:rounds <n>",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			if (isNaN(num) || num < 1) {
				const active = fresh.state.phase !== "idle" ? fresh.state : incremental.state.phase !== "idle" ? incremental.state : exec.state.phase !== "idle" ? exec.state : manual.state;
				ctx.ui.notify(`Current max rounds: ${active.phase !== "idle" ? active.maxRounds : loadConfig(ctx.cwd).maxRounds}. Usage: /loop:rounds <n>`, "info");
				return;
			}
			if (fresh.state.phase !== "idle") fresh.state.maxRounds = num;
			else if (incremental.state.phase !== "idle") incremental.state.maxRounds = num;
			else if (exec.state.phase !== "idle") exec.state.maxRounds = num;
			else if (manual.state.phase !== "idle") manual.state.maxRounds = num;
			saveConfigField("maxRounds", num);
			ctx.ui.notify(`Max rounds → ${num}`, "info");
		},
	});

	pi.registerCommand("loop:log", {
		description: "Browse overseer + workhorse logs in a modal viewer",
		handler: async (_args, ctx) => {
			const fState = fresh.state;
			const iState = incremental.state;
			const xState = exec.state;
			const mState = manual.state;
			const results = fState.initialRequest ? fState : iState.initialRequest ? iState : xState.initialRequest ? xState : mState;
			if (results.roundResults.length === 0 && !results.initialRequest) { ctx.ui.notify("No loop rounds recorded yet.", "info"); return; }
			await showLog(results.initialRequest, results.roundResults, ctx, results.loopStartedAt);
		},
	});

	pi.registerCommand("loop:debug", {
		description: "Simulate a 3-round review loop and open the log viewer",
		handler: async (_args, ctx) => {
			const demo = buildDemoData();
			await showLog(demo.initialRequest, demo.roundResults, ctx, demo.loopStartedAt);
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
					ctx.ui.notify(`Plannotator → ${newVal ? "enabled" : "disabled"}`, "info");
				}
				else if (action.startsWith("Rewrite history")) {
					const newVal = !cfg.rewriteHistory;
					saveConfigField("rewriteHistory", newVal as any);
					ctx.ui.notify(`Rewrite history → ${newVal ? "enabled" : "disabled"}`, "info");
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
		if (model !== current) { saveConfigField(field, model); ctx.ui.notify(`${field} → ${model}`, "info"); }
	}

	async function editMaxRounds(current: number, ctx: any): Promise<void> {
		const val = await ctx.ui.input("Max rounds", String(current));
		const num = val ? parseInt(val, 10) : NaN;
		if (!isNaN(num) && num > 0 && num !== current) { saveConfigField("maxRounds", num); ctx.ui.notify(`Max rounds → ${num}`, "info"); }
	}

	async function pickThinking(field: "overseerThinking" | "workhorseThinking", current: string, ctx: any): Promise<void> {
		const picked = await ctx.ui.select(`Select thinking level`,
			THINKING_LEVELS.map(l => l === current ? `${l}  ✓` : l));
		if (!picked) return;
		const level = picked.replace(/\s+✓$/, "");
		if (level !== current) { saveConfigField(field, level); ctx.ui.notify(`${field} → ${level}`, "info"); }
	}

	async function pickReviewMode(current: ReviewMode, ctx: any): Promise<void> {
		const picked = await ctx.ui.select("Loop mode", [
			`fresh${current === "fresh" ? "  ✓" : ""}  — clean overseer each round, holistic re-review`,
			`incremental${current === "incremental" ? "  ✓" : ""}  — overseer keeps context, only gets workhorse summary`,
		]);
		if (!picked) return;
		const mode = picked.split(/\s/)[0] as ReviewMode;
		if (mode !== current) { saveConfigField("reviewMode", mode); ctx.ui.notify(`Loop mode → ${mode}`, "info"); }
	}
}
