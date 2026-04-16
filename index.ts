/**
 * Loop Extension — automated loop between an overseer and workhorse model.
 *
 * /loop [focus] [@path ...]       — Start review loop
 * /loop:exec [focus] [@path ...]  — Start exec loop (plan orchestrator → workhorse)
 * /loop:manual [range]            — Manual review (you drive, commit by commit)
 * /loop:resume                    — Resume loop from session state
 * /loop:rounds <n>                — Change max rounds
 * /loop:stop                      — Stop the loop
 * /loop:log                       — Browse verdicts and workhorse summaries
 * /loop:cfg                       — Settings UI
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewMode } from "./types.js";
import { loadConfig, getScopedModels, saveConfigField, THINKING_LEVELS } from "./config.js";
import { createSession } from "./session.js";
import { createStatus, killGhostTimers } from "./status.js";
import { createFreshReview } from "./review-fresh.js";
import { createIncrementalReview } from "./review-incremental.js";
import { createExecMode } from "./exec.js";
import { createManualMode } from "./manual.js";
import { createPlannotator } from "./plannotator.js";
import { showLog } from "./log-view.js";
import { buildDemoData } from "./demo.js";

export { showLog } from "./log-view.js";
export { loadConfig, saveConfigField } from "./config.js";

export interface LoopExtensionOpts {
	reviewFn?: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string };
}

export default function (pi: ExtensionAPI, opts?: LoopExtensionOpts) {
	const session = createSession(pi);
	const status = createStatus();
	const fresh = createFreshReview(session, status);
	const incremental = createIncrementalReview(session, status);
	const exec = createExecMode(session, status);
	const plannotator = createPlannotator(pi.events?.emit?.bind(pi.events) ?? null);
	const manual = createManualMode(session, status, {
		reviewFn: opts?.reviewFn,
		plannotator,
	});
	const allModes = [fresh, incremental, exec, manual] as const;

	// Kill ghost timers from previous extension instance (hot reload).
	// Must run here — ESM caches modules so top-level code only executes once.
	killGhostTimers();

	function activeMode() {
		return allModes.find(m => m.isRunning()) ?? null;
	}

	pi.registerCommand("loop", {
		description: "Start loop. Usage: /loop [focus] [@path ...]",
		handler: async (args, ctx) => {
			if (activeMode()) { ctx.ui.notify("A loop is already running — /loop:stop to cancel", "warning"); return; }
			const cfg = loadConfig(ctx.cwd);
			if (cfg.reviewMode === "fresh") return fresh.start(args, ctx);
			return incremental.start(args, ctx);
		},
	});

	pi.registerCommand("loop:exec", {
		description: "Start exec loop (orchestrator → workhorse). Usage: /loop:exec [focus] [@path ...]",
		handler: async (args, ctx) => {
			if (activeMode()) { ctx.ui.notify("A loop is already running — /loop:stop to cancel", "warning"); return; }
			return exec.start(args, ctx);
		},
	});

	pi.registerCommand("loop:manual", {
		description: "Manual review. Usage: /loop:manual [sha|range]",
		handler: async (args, ctx) => {
			if (activeMode()) { ctx.ui.notify("A loop is already running — /loop:stop to cancel", "warning"); return; }
			return manual.start(args, ctx);
		},
	});

	const resumable = new Map<string, { resume(ctx: any, anchor: { id: string; data: any }): Promise<void> }>([
		["fresh", fresh], ["incremental", incremental], ["exec", exec], ["manual", manual],
	]);

	pi.registerCommand("loop:resume", {
		description: "Resume loop from session state",
		handler: async (_args, ctx) => {
			if (activeMode()) { ctx.ui.notify("A loop is already running — /loop:stop to cancel", "warning"); return; }
			const anchor = session.findAnchor(ctx);
			const target = anchor ? resumable.get(anchor.data?.mode) : undefined;
			if (!target || !anchor) { ctx.ui.notify("Nothing to resume. Use /loop to start.", "info"); return; }
			await target.resume(ctx, anchor);
		},
	});

	pi.registerCommand("loop:stop", {
		description: "Stop the loop",
		handler: async (_args, ctx) => {
			const active = activeMode();
			if (active) {
				ctx.ui.notify("Loop stopped", "info");
				await active.stop(ctx);
			}
			// Always clear status bar — kills ghost timers from hot reloads
			ctx.ui.setStatus("loop", "");
		},
	});

	pi.registerCommand("loop:rounds", {
		description: "Change max rounds: /loop:rounds <n>",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			const active = activeMode();
			if (isNaN(num) || num < 1) {
					ctx.ui.notify(`Current max rounds: ${active ? active.getMaxRounds() : loadConfig(ctx.cwd).maxRounds}. Usage: /loop:rounds <n>`, "info");
				return;
			}
			if (active) active.setMaxRounds(num);
			saveConfigField("maxRounds", num);
			ctx.ui.notify(`Max rounds → ${num}`, "info");
		},
	});

	pi.registerCommand("loop:log", {
		description: "Browse overseer + workhorse logs in a modal viewer",
		handler: async (_args, ctx) => {
			// Pick the most recent run by loopStartedAt.
			const snapshots = allModes
				.map(m => m.logSnapshot())
				.filter((s): s is NonNullable<typeof s> => s !== null)
				.sort((a, b) => b.loopStartedAt - a.loopStartedAt);
			const best = snapshots[0];
			if (!best || (best.roundResults.length === 0 && !best.initialRequest)) {
				ctx.ui.notify("No loop rounds recorded yet.", "info"); return;
			}
			await showLog(best.initialRequest, best.roundResults, ctx, best.loopStartedAt);
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
