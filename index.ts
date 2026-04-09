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
import { showReviewLog } from "./log-view.js";

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
	let loopCommandCtx: any | null = null;

	function deferIf(phase: string, fn: () => void): void {
		setTimeout(() => { if (state.phase === phase) fn(); }, 100);
	}

	function log(text: string): void {
		pi.sendMessage({ customType: "review-log", content: text, display: true }, { triggerTurn: false });
	}

	function findReviewAnchor(ctx: any): { id: string; data: any } | null {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === "review-anchor") return { id: e.id, data: e.data };
		}
		return null;
	}

	function rememberReviewAnchor(ctx: any): void {
		pi.appendEntry("review-anchor", {
			focus: state.focus,
			initialRequest: state.initialRequest,
			contextPaths: state.contextPaths,
		});
		state.anchorEntryId = ctx.sessionManager.getLeafId();
	}

	async function navigateToEntry(targetId: string, ctx: any): Promise<boolean> {
		if (typeof ctx.navigateTree !== "function") {
			ctx.ui.notify("Review transition requires command context", "error");
			await stopLoop(ctx);
			return false;
		}
		const result = await ctx.navigateTree(targetId, { summarize: false });
		return !result?.cancelled;
	}

	async function navigateToAnchor(ctx: any): Promise<boolean> {
		if (!state.anchorEntryId) state.anchorEntryId = findReviewAnchor(ctx)?.id ?? null;
		if (!state.anchorEntryId) {
			ctx.ui.notify("No review anchor found", "error");
			await stopLoop(ctx);
			return false;
		}
		return navigateToEntry(state.anchorEntryId, ctx);
	}

	async function continueLoop(eventCtx: any, action: { type: "review"; summaryText?: string } | { type: "fix"; reviewText: string }): Promise<void> {
		const ctx = loopCommandCtx;
		if (!ctx) {
			eventCtx.ui.notify("Review loop lost its command context", "error");
			await stopLoop(eventCtx);
			return;
		}
		await ctx.waitForIdle();
		if (action.type === "fix") await startFix(action.reviewText, ctx);
		else await startReview(ctx, action.summaryText);
	}

	async function setAgent(modelStr: string, thinking: string, ctx: any): Promise<boolean> {
		const model = findModel(modelStr, ctx);
		if (!model) { ctx.ui.notify(`Model not found: ${modelStr}`, "error"); await stopLoop(ctx); return false; }
		if (!await pi.setModel(model)) { ctx.ui.notify(`No API key for model: ${modelStr}`, "error"); await stopLoop(ctx); return false; }
		pi.setThinkingLevel(thinking);
		return true;
	}

	// ── Transitions ─────────────────────────────────────

	async function startReview(ctx: any, summaryText?: string): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		if (state.reviewMode === "fresh") {
			if (!await navigateToAnchor(ctx)) return;
		} else if (state.round > 1) {
			if (!state.reviewLeafId) {
				ctx.ui.notify("No review branch to return to", "error");
				await stopLoop(ctx);
				return;
			}
			if (!await navigateToEntry(state.reviewLeafId, ctx)) return;
			if (summaryText) {
				pi.sendMessage({ customType: "fixer-summary", content: summaryText, display: true }, { triggerTurn: false });
			}
		}
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
		if (!await navigateToAnchor(ctx)) return;
		if (!await setAgent(cfg.fixerModel, cfg.fixerThinking, ctx)) return;

		state.phase = "fixing";
		ctx.ui.setStatus("review", `🔧 Round ${state.round}/${state.maxRounds} · ${cfg.fixerModel} fixing`);
		log(`[Round ${state.round}] Fixer: ${cfg.fixerModel}`);
		pi.sendUserMessage(buildFixPrompt(reviewText, state.contextPaths, state.round));
	}

	async function onFixerDone(fixerText: string, eventCtx: any): Promise<void> {
		const summary = sanitize(stripVerdict(fixerText));
		const summaryText = `[Fixer Round ${state.round}] ${summary}`;
		state.fixerSummaries.push(summaryText);
		recordFixer(state.round, summaryText);
		log(`🔧 Fixes applied\n${summary}`);
		state.round++;
		await continueLoop(eventCtx, { type: "review", summaryText: state.reviewMode === "incremental" ? summaryText : undefined });
	}

	async function stopLoop(ctx: any): Promise<void> {
		const wasRunning = state.phase !== "idle";
		state.phase = "idle";
		state.reviewLeafId = null;
		loopCommandCtx = null;
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
			log(`✅ APPROVED`);
			deferIf("reviewing", () => { ctx.ui.notify(`✅ Approved after ${state.round} round(s)`, "success"); stopLoop(ctx); });
			return;
		}
		if (verdict === "changes_requested") {
			recordReview(state.round, "changes_requested", text);
			const summary = sanitize(stripVerdict(text));
			log(`❌ CHANGES REQUESTED\n${summary}`);
			deferIf("reviewing", () => {
				if (state.round >= state.maxRounds) { ctx.ui.notify(`⚠️ Hit ${state.maxRounds} rounds without approval`, "warning"); void stopLoop(ctx); return; }
				void continueLoop(ctx, { type: "fix", reviewText: text });
			});
			return;
		}
		deferIf("reviewing", () => pi.sendUserMessage("Continue your review. When done, end with VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED"));
	}

	function handleFixerEnd(text: string, ctx: any): void {
		if (hasFixesComplete(text)) {
			deferIf("fixing", () => { const t = getLastAssistant(ctx).text; if (t.trim()) void onFixerDone(t, ctx); });
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
			const trimmedArgs = (args || "").trim();
			const { focus, contextPaths } = parseArgs(trimmedArgs, ctx.cwd);
			loopCommandCtx = ctx;
			state = newState({
				round: 1, focus, initialRequest: trimmedArgs || "(no focus specified)", contextPaths,
				maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
			});
			log(`📝 Request\n${state.initialRequest}`);
			rememberReviewAnchor(ctx);
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
			const anchor = findReviewAnchor(ctx);
			const cfg = loadConfig(ctx.cwd);
			loopCommandCtx = ctx;
			state = newState({
				round: recovered.round,
				focus: anchor?.data?.focus ?? recovered.focus,
				initialRequest: anchor?.data?.initialRequest ?? (recovered.focus || "(no focus specified)"),
				contextPaths: Array.isArray(anchor?.data?.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
				reviewLeafId: recovered.reviewLeafId,
				anchorEntryId: anchor?.id ?? null,
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
		description: "Browse reviewer + fixer logs in a modal viewer",
		handler: async (_args, ctx) => {
			if (state.roundResults.length === 0 && !state.initialRequest) { ctx.ui.notify("No review rounds recorded yet.", "info"); return; }
			await showReviewLog(state.initialRequest, state.roundResults, ctx);
		},
	});

	pi.registerCommand("review:debug", {
		description: "Simulate a 3-round review loop and open the log viewer",
		handler: async (_args, ctx) => {
			const rounds = [
				{
					review: [
						"## Critical Issues",
						"",
						"### 1. Race condition in `handleConn()`",
						"",
						"The `connMap` is accessed without a mutex. Multiple goroutines write to it",
						"concurrently when connections spike. I traced this through the call chain:",
						"",
						"```go",
						"// server.go:45 — spawns a goroutine per connection",
						"go func() {",
						"    connMap[conn.RemoteAddr()] = conn  // unsynchronized write",
						"    handleConn(conn)",
						"}()",
						"```",
						"",
						"Under load testing with 500 concurrent connections, this triggers",
						"`fatal error: concurrent map writes` roughly 1 in 3 runs.",
						"",
						"### 2. Error swallowed silently",
						"",
						"On line 87:",
						"```go",
						"resp, _ := client.Do(req)",
						"```",
						"",
						"This hides network failures from callers. When the upstream service is down,",
						"the handler silently returns a nil response, causing a nil pointer dereference",
						"three lines later at `resp.StatusCode`.",
						"",
						"### 3. Missing context propagation",
						"",
						"`handleConn` creates `context.Background()` instead of using the parent",
						"context from the server. This means:",
						"- Server shutdown won't cancel in-flight handlers",
						"- Client disconnects won't propagate",
						"- Timeout enforcement at the server level is bypassed",
						"",
						"### 4. Missing `defer conn.Close()`",
						"",
						"The connection is only closed in the happy path (line 102). If any of the",
						"intermediate steps return an error, the connection leaks. Under sustained",
						"load this will exhaust file descriptors.",
						"",
						"**VERDICT:** CHANGES_REQUESTED",
					].join("\n"),
					fix: [
						"Added sync.RWMutex around connMap access — write lock only for",
						"map insertion, read lock for lookups.",
						"",
						"Propagated error from client.Do with wrapped context:",
						"```go",
						"resp, err := client.Do(req)",
						"if err != nil {",
						'    return fmt.Errorf("handleConn: upstream request: %w", err)',
						"}",
						"```",
						"",
						"Threaded parent context through handleConn. Added defer conn.Close().",
						"",
						"New tests:",
						"- `TestHandleConnConcurrent` — 500 goroutines, race detector enabled",
						"- `TestHandleConnContextCancel` — verifies handler exits on parent cancel",
						"- `TestHandleConnUpstreamError` — verifies error propagation",
						"- `TestHandleConnLeak` — verifies conn.Close on all exit paths",
					].join("\n"),
				},
				{
					review: [
						"## Improvements needed",
						"",
						"Good progress. The race condition fix and error handling are solid.",
						"Two remaining issues:",
						"",
						"### Lock granularity is too coarse",
						"",
						"You're holding the write lock for the entire `handleConn` duration.",
						"This effectively serializes all connections — defeating the purpose of",
						"the goroutine-per-connection model.",
						"",
						"Current code:",
						"```go",
						"mu.Lock()",
						"connMap[addr] = conn",
						"handleConnInner(ctx, conn)  // entire handler under lock!",
						"delete(connMap, addr)",
						"mu.Unlock()",
						"```",
						"",
						"Should be:",
						"```go",
						"mu.Lock()",
						"connMap[addr] = conn",
						"mu.Unlock()",
						"",
						"handleConnInner(ctx, conn)  // no lock held",
						"",
						"mu.Lock()",
						"delete(connMap, addr)",
						"mu.Unlock()",
						"```",
						"",
						"Use `RLock` for read-only access in the health check endpoint.",
						"",
						"### Deprecated error wrapping",
						"",
						"You're using `errors.Wrap` from `pkg/errors` which is unmaintained.",
						"Switch to stdlib:",
						"```go",
						"// before",
						'errors.Wrap(err, "handleConn")',
						"// after",
						'fmt.Errorf("handleConn: %w", err)',
						"```",
						"",
						"Tests look solid — the race detector test is a nice touch.",
						"",
						"**VERDICT:** CHANGES_REQUESTED",
					].join("\n"),
					fix: [
						"Narrowed lock scope:",
						"- Lock only for map insertion and deletion",
						"- RLock for the health check endpoint's connection count",
						"- Handler runs entirely outside the critical section",
						"",
						"Switched all error wrapping to fmt.Errorf with %w.",
						"Removed pkg/errors dependency entirely.",
						"",
						"Benchmarked with `go test -bench=BenchmarkConcurrentConns -count=5`:",
						"- Before: 3,200 conns/sec (serialized by lock)",
						"- After: 10,400 conns/sec (3.2x improvement)",
						"- p99 latency: 12ms → 3ms",
					].join("\n"),
				},
				{
					review: [
						"## Final review",
						"",
						"All issues from rounds 1 and 2 are resolved:",
						"",
						"- [x] Race condition fixed with properly scoped mutex",
						"- [x] Error propagation using stdlib fmt.Errorf",
						"- [x] Context propagation from server to handler",
						"- [x] Connection leak fixed with defer",
						"- [x] Lock granularity narrowed — handler outside critical section",
						"- [x] pkg/errors dependency removed",
						"",
						"The benchmark numbers confirm the lock contention was real —",
						"3.2x throughput improvement and 4x latency reduction.",
						"",
						"Test coverage is comprehensive:",
						"- Concurrent access with race detector",
						"- Context cancellation propagation",
						"- Upstream error handling",
						"- Connection lifecycle (no leaks)",
						"",
						"Clean code, good tests. Ship it.",
						"",
						"**VERDICT:** APPROVED",
					].join("\n"),
					fix: "",
				},
			];

			// Feed through the real state machinery
			state = newState({ initialRequest: "fix race condition in connection handler @internal/server/conn.go" });
			for (const r of rounds) {
				state.round++;
				const verdict = matchVerdict(r.review);
				if (verdict) recordReview(state.round, verdict, r.review);
				if (r.fix) {
					const summary = `[Fixer Round ${state.round}] ${sanitize(stripVerdict(r.fix))}`;
					recordFixer(state.round, summary);
				}
			}
			await showReviewLog(state.initialRequest, state.roundResults, ctx);
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
