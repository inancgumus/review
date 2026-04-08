/**
 * Review Extension — automated review loop between a reviewer and fixer model.
 *
 * /review [focus] [@path ...]  — Start review loop
 * /review:resume               — Resume from session state
 * /review:rounds <n>           — Change max rounds
 * /review:stop                 — Stop the loop
 * /review:log                  — Browse verdicts and fixer summaries
 * /review:cfg                  — Settings UI
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { LoopState, ReviewMode } from "./types.js";
import { newState } from "./types.js";
import { loadConfig, getScopedModels, saveConfigField, THINKING_LEVELS } from "./config.js";
import { parseArgs } from "./context.js";
import { buildReviewPrompt, buildFixPrompt } from "./prompts.js";
import { matchVerdict, hasFixesComplete, stripVerdict } from "./verdicts.js";
import { sanitize, modelToStr, findModel, getLastAssistant } from "./session.js";
import { reconstructState } from "./reconstruct.js";

// Block interactive editors during agent turns.
// GIT_EDITOR/EDITOR/VISUAL → fail with actionable message so the agent retries correctly.
// GIT_SEQUENCE_EDITOR → auto-accept ("true") so `git rebase -i --autosquash` works.
const EDITOR_BLOCK = `sh -c 'echo "ERROR: Interactive editor blocked during review loop. Use: git commit -m \"msg\" or --no-edit for amends. For rebase, prefix with GIT_SEQUENCE_EDITOR=true or GIT_SEQUENCE_EDITOR=\"sed ...\"" >&2; exit 1'`;
const EDITOR_VARS = { GIT_EDITOR: EDITOR_BLOCK, EDITOR: EDITOR_BLOCK, VISUAL: EDITOR_BLOCK, GIT_SEQUENCE_EDITOR: "true" };
let savedEnv: Record<string, string | undefined> = {};

function blockInteractiveEditors(): void {
	for (const [k, v] of Object.entries(EDITOR_VARS)) {
		savedEnv[k] = process.env[k];
		process.env[k] = v;
	}
}

function restoreEditorEnv(): void {
	for (const k of Object.keys(EDITOR_VARS)) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	savedEnv = {};
}

export default function (pi: ExtensionAPI) {
	let state: LoopState = newState();

	function deferIf(phase: string, fn: () => void): void {
		setTimeout(() => { if (state.phase === phase) fn(); }, 100);
	}

	function log(text: string): void {
		pi.sendMessage({ customType: "review-log", content: text, display: true }, { triggerTurn: false });
	}

	function branchToRoot(ctx: any): void {
		const entries = ctx.sessionManager.getEntries();
		if (entries.length > 0) ctx.sessionManager.branch(entries[0].id);
	}

	async function setAgent(modelStr: string, thinking: string, ctx: any): Promise<boolean> {
		const model = findModel(modelStr, ctx);
		if (!model) { ctx.ui.notify(`Model not found: ${modelStr}`, "error"); await stopLoop(ctx); return false; }
		await pi.setModel(model);
		pi.setThinkingLevel(thinking);
		return true;
	}

	// ── Transitions ─────────────────────────────────────

	async function startReview(ctx: any): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		if (state.round > 1 && state.reviewMode === "fresh") branchToRoot(ctx);
		if (!await setAgent(cfg.reviewerModel, cfg.reviewerThinking, ctx)) return;

		state.phase = "reviewing";
		state.reviewLeafId = null;
		ctx.ui.setStatus("review", `🔍 Round ${state.round}/${state.maxRounds} · ${cfg.reviewerModel} reviewing`);
		log(`[Round ${state.round}] Reviewer: ${cfg.reviewerModel} · mode: ${state.reviewMode}`);
		pi.sendUserMessage(buildReviewPrompt({
			focus: state.focus, round: state.round, reviewMode: state.reviewMode,
			contextPaths: state.contextPaths, fixerSummaries: state.fixerSummaries,
		}));
	}

	async function startFix(reviewText: string, ctx: any): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		state.reviewLeafId = ctx.sessionManager.getLeafId();
		branchToRoot(ctx);
		if (!await setAgent(cfg.fixerModel, cfg.fixerThinking, ctx)) return;

		state.phase = "fixing";
		ctx.ui.setStatus("review", `🔧 Round ${state.round}/${state.maxRounds} · ${cfg.fixerModel} fixing`);
		log(`[Round ${state.round}] Fixer: ${cfg.fixerModel}`);
		pi.sendUserMessage(buildFixPrompt(reviewText, state.contextPaths, state.round));
	}

	async function onFixerDone(fixerText: string, ctx: any): Promise<void> {
		const summary = sanitize(stripVerdict(fixerText)).slice(0, 800);
		const summaryText = `[Fixer Round ${state.round}] ${summary}`;
		state.fixerSummaries.push(summaryText);
		recordFixer(state.round, summaryText);

		if (state.reviewMode === "incremental") {
			if (!state.reviewLeafId) { ctx.ui.notify("No review branch to return to", "error"); await stopLoop(ctx); return; }
			ctx.sessionManager.branch(state.reviewLeafId);
			pi.sendMessage({ customType: "fixer-summary", content: summaryText, display: true }, { triggerTurn: false });
		}
		state.reviewLeafId = null;
		state.round++;
		await startReview(ctx);
	}

	async function stopLoop(ctx: any): Promise<void> {
		const wasRunning = state.phase !== "idle";
		state.phase = "idle";
		state.reviewLeafId = null;
		ctx.ui.setStatus("review", "");
		restoreEditorEnv();
		if (!wasRunning || !state.originalModelStr) return;

		const model = findModel(state.originalModelStr, ctx);
		if (!model) { ctx.ui.notify(`Could not restore model: ${state.originalModelStr}`, "error"); return; }
		await pi.setModel(model);
		pi.setThinkingLevel(state.originalThinking);
		log(`Review loop ended. Restored model: ${state.originalModelStr} · thinking: ${state.originalThinking}`);
	}

	// ── agent_end ───────────────────────────────────────

	pi.on("agent_end", (_event, ctx) => {
		if (state.phase === "idle") return;
		const { text, stopReason } = getLastAssistant(ctx);
		if (!text.trim()) return;
		if (stopReason === "abort" || stopReason === "aborted" || stopReason === "cancelled") return;

		if (state.phase === "reviewing") handleReviewerEnd(text, ctx);
		else if (state.phase === "fixing") handleFixerEnd(text, ctx);
	});

	function handleReviewerEnd(text: string, ctx: any): void {
		const verdict = matchVerdict(text);

		if (verdict === "approved") {
			recordReview(state.round, "approved", text);
			deferIf("reviewing", () => { ctx.ui.notify(`✅ Approved after ${state.round} round(s)`, "success"); stopLoop(ctx); });
			return;
		}
		if (verdict === "changes_requested") {
			recordReview(state.round, "changes_requested", text);
			deferIf("reviewing", () => {
				if (state.round >= state.maxRounds) { ctx.ui.notify(`⚠️ Hit ${state.maxRounds} rounds without approval`, "warning"); stopLoop(ctx); return; }
				startFix(text, ctx);
			});
			return;
		}
		deferIf("reviewing", () => pi.sendUserMessage("Continue your review. When done, end with VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED"));
	}

	function handleFixerEnd(text: string, ctx: any): void {
		if (hasFixesComplete(text)) {
			deferIf("fixing", () => { const t = getLastAssistant(ctx).text; if (t.trim()) onFixerDone(t, ctx); });
			return;
		}
		deferIf("fixing", () => pi.sendUserMessage("Continue addressing the remaining issues. When all fixes are done, end with FIXES_COMPLETE"));
	}

	// ── Round tracking ──────────────────────────────────

	function recordReview(round: number, verdict: "approved" | "changes_requested", text: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) { r.verdict = verdict; r.reviewText = text; }
		else state.roundResults.push({ round, verdict, reviewText: text, fixerSummary: "" });
	}

	function recordFixer(round: number, summary: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) r.fixerSummary = summary;
	}

	// ── Commands ────────────────────────────────────────

	pi.registerCommand("review", {
		description: "Start review loop. Usage: /review [focus] [@path ...]",
		handler: async (args, ctx) => {
			if (state.phase !== "idle") { ctx.ui.notify("Review loop already running — /review:stop to cancel", "warning"); return; }
			const cfg = loadConfig(ctx.cwd);
			const { focus, contextPaths } = parseArgs(args || "", ctx.cwd);
			state = newState({
				round: 1, focus, contextPaths,
				maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
			});
			blockInteractiveEditors();
			ctx.ui.notify(`Saving model: ${state.originalModelStr} · ${state.originalThinking}`, "info");
			await ctx.waitForIdle();
			await startReview(ctx);
		},
	});

	pi.registerCommand("review:resume", {
		description: "Resume review loop from session state",
		handler: async (_args, ctx) => {
			if (state.phase !== "idle") { ctx.ui.notify("Review loop already running", "warning"); return; }
			const recovered = reconstructState(ctx);
			if (!recovered) { ctx.ui.notify("Nothing to resume. Use /review to start.", "info"); return; }
			const cfg = loadConfig(ctx.cwd);
			state = newState({
				round: recovered.round, focus: recovered.focus,
				maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
			});
			blockInteractiveEditors();
			ctx.ui.notify(`Resuming round ${recovered.round} (${recovered.phase} phase)`, "info");
			await ctx.waitForIdle();
			if (recovered.phase === "fix" && recovered.lastReviewText) await startFix(recovered.lastReviewText, ctx);
			else await startReview(ctx);
		},
	});

	pi.registerCommand("review:stop", {
		description: "Stop the review loop",
		handler: async (_args, ctx) => {
			if (state.phase === "idle") { ctx.ui.notify("No review loop running", "info"); return; }
			ctx.ui.notify("Review loop stopped", "info");
			await stopLoop(ctx);
		},
	});

	pi.registerCommand("review:rounds", {
		description: "Change max rounds: /review:rounds <n>",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			if (isNaN(num) || num < 1) {
				ctx.ui.notify(`Current max rounds: ${state.phase !== "idle" ? state.maxRounds : loadConfig(ctx.cwd).maxRounds}. Usage: /review:rounds <n>`, "info");
				return;
			}
			state.maxRounds = num;
			saveConfigField("maxRounds", num);
			if (state.phase !== "idle") ctx.ui.setStatus("review", `${state.phase === "reviewing" ? "🔍" : "🔧"} Round ${state.round}/${num}`);
			ctx.ui.notify(`Max rounds → ${num}`, "success");
		},
	});

	pi.registerCommand("review:log", {
		description: "Browse review verdicts and fixer summaries",
		handler: async (_args, ctx) => {
			if (state.roundResults.length === 0) { ctx.ui.notify("No review rounds recorded yet.", "info"); return; }

			const items = state.roundResults.flatMap(r => {
				const icon = r.verdict === "approved" ? "✅" : r.verdict === "changes_requested" ? "❌" : "⏳";
				const lines = [`${icon} Round ${r.round}: ${(r.verdict || "pending").toUpperCase()}`];
				if (r.fixerSummary) lines.push(`  🔧 ${r.fixerSummary.slice(0, 120)}`);
				return lines;
			});

			const picked = await ctx.ui.select("Review Log", items);
			if (!picked) return;
			const m = picked.match(/Round (\d+)/);
			if (!m) return;
			const result = state.roundResults.find(r => r.round === parseInt(m[1], 10));
			if (!result) return;

			await ctx.ui.select(`Round ${result.round} Detail`, [
				`── Round ${result.round} ──`,
				`Verdict: ${(result.verdict || "pending").toUpperCase()}`,
				"", result.reviewText.slice(0, 2000),
				...(result.fixerSummary ? ["", "── Fixer ──", result.fixerSummary] : []),
			]);
		},
	});

	pi.registerCommand("review:cfg", {
		description: "View or change review loop settings",
		handler: async (_args, ctx) => {
			while (true) {
				const cfg = loadConfig(ctx.cwd);
				const action = await ctx.ui.select("Review Settings", [
					`Reviewer model: ${cfg.reviewerModel}`,
					`Reviewer thinking: ${cfg.reviewerThinking}`,
					`Fixer model: ${cfg.fixerModel}`,
					`Fixer thinking: ${cfg.fixerThinking}`,
					`Max rounds: ${cfg.maxRounds}`,
					`Review mode: ${cfg.reviewMode}`,
				]);
				if (!action) break;
				if (action.startsWith("Reviewer model")) await pickModel("reviewerModel", cfg, ctx);
				else if (action.startsWith("Reviewer thinking")) await pickThinking("reviewerThinking", cfg.reviewerThinking, ctx);
				else if (action.startsWith("Fixer model")) await pickModel("fixerModel", cfg, ctx);
				else if (action.startsWith("Fixer thinking")) await pickThinking("fixerThinking", cfg.fixerThinking, ctx);
				else if (action.startsWith("Max rounds")) await editMaxRounds(cfg.maxRounds, ctx);
				else if (action.startsWith("Review mode")) await pickReviewMode(cfg.reviewMode, ctx);
			}
		},
	});

	async function pickModel(field: "reviewerModel" | "fixerModel", cfg: ReturnType<typeof loadConfig>, ctx: any): Promise<void> {
		const models = getScopedModels(ctx.cwd);
		if (models.length === 0) { ctx.ui.notify("No enabledModels in settings.json", "error"); return; }
		const current = cfg[field];
		const picked = await ctx.ui.select(`Select ${field === "reviewerModel" ? "reviewer" : "fixer"} model`,
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

	async function pickThinking(field: "reviewerThinking" | "fixerThinking", current: string, ctx: any): Promise<void> {
		const picked = await ctx.ui.select(`Select thinking level`,
			THINKING_LEVELS.map(l => l === current ? `${l}  ✓` : l));
		if (!picked) return;
		const level = picked.replace(/\s+✓$/, "");
		if (level !== current) { saveConfigField(field, level); ctx.ui.notify(`${field} → ${level}`, "success"); }
	}

	async function pickReviewMode(current: ReviewMode, ctx: any): Promise<void> {
		const picked = await ctx.ui.select("Review mode", [
			`fresh${current === "fresh" ? "  ✓" : ""}  — clean reviewer each round, holistic re-review`,
			`incremental${current === "incremental" ? "  ✓" : ""}  — reviewer keeps context, only gets fixer summary`,
		]);
		if (!picked) return;
		const mode = picked.split(/\s/)[0] as ReviewMode;
		if (mode !== current) { saveConfigField("reviewMode", mode); ctx.ui.notify(`Review mode → ${mode}`, "success"); }
	}
}
