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
import type { LoopMode, LoopState, ReviewMode } from "./types.js";
import { newState } from "./types.js";
import { loadConfig, getScopedModels, saveConfigField, THINKING_LEVELS } from "./config.js";
import { parseArgs, snapshotContextHashes, changedContextPaths as findChangedContextPaths } from "./context.js";
import { promptSets } from "./prompts.js";
import { matchVerdict, hasFixesComplete, stripVerdict } from "./verdicts.js";
import { sanitize, modelToStr, findModel, getLastAssistant } from "./session.js";
import { reconstructState } from "./reconstruct.js";
import { showLog } from "./log-view.js";
import { extractTaggedSHAs, snapshotPatchIds, detectUnchanged, resolveSubjects, findSnapshotBase } from "./fixup-audit.js";
import { resolveRange, getCommitList, getCommitDiff, getCommitSubject, buildPatchIdMap, remapAfterRebase, checkGitState, fixGitState } from "./git-manual.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

// Block interactive editors during agent turns.
// GIT_EDITOR/EDITOR/VISUAL → fail with actionable message so the agent retries correctly.
// GIT_SEQUENCE_EDITOR → auto-accept ("true") so `git rebase -i --autosquash` works.
const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

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

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h ${m % 60}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export default function (pi: ExtensionAPI) {
	let state: LoopState = newState();
	let loopCommandCtx: any | null = null;
	let statusPrefix = "";
	let statusTimer: ReturnType<typeof setInterval> | null = null;

	function totalElapsed(): number {
		if (!state.loopStartedAt) return 0;
		return Date.now() - state.loopStartedAt - state.pausedElapsed;
	}

	function updateStatus(ctx: any): void {
		if (state.phase === "idle" || !statusPrefix) return;
		const now = Date.now();
		let status = statusPrefix;
		if (state.roundStartedAt) status += ` · ⏱ Round ${state.round}: ${formatDuration(now - state.roundStartedAt)}`;
		if (state.loopStartedAt) {
			// In awaiting_feedback, show paused total; otherwise show live total
			if (state.phase === "awaiting_feedback") {
				status += ` · ⏸ Total: ${formatDuration(totalElapsed())}`;
			} else {
				status += ` · ⏱ Total: ${formatDuration(totalElapsed())}`;
			}
		}
		ctx.ui.setStatus("loop", status);
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

	function deferIf(phase: string | string[], fn: () => void): void {
		const phases = Array.isArray(phase) ? phase : [phase];
		setTimeout(() => { if (phases.includes(state.phase)) fn(); }, 100);
	}

	function log(text: string): void {
		pi.sendMessage({ customType: "loop-log", content: text, display: true }, { triggerTurn: false, deliverAs: "followUp" });
	}

	function findAnchor(ctx: any): { id: string; data: any } | null {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === "loop-anchor") return { id: e.id, data: e.data };
		}
		return null;
	}

	function rememberAnchor(ctx: any): void {
		pi.appendEntry("loop-anchor", {
			focus: state.focus,
			initialRequest: state.initialRequest,
			contextPaths: state.contextPaths,
			// Manual mode
			mode: state.mode,
			commitList: state.mode === "manual" ? state.commitList : undefined,
			currentCommitIdx: state.mode === "manual" ? state.currentCommitIdx : undefined,
			manualBase: state.mode === "manual" ? state.manualBase : undefined,
		});
		state.anchorEntryId = ctx.sessionManager.getLeafId();
	}

	async function navigateToEntry(targetId: string, ctx: any): Promise<boolean> {
		if (typeof ctx.navigateTree !== "function") {
			ctx.ui.notify("Loop transition requires command context", "error");
			await stopLoop(ctx);
			return false;
		}
		const result = await ctx.navigateTree(targetId, { summarize: false });
		return !result?.cancelled;
	}

	async function navigateToAnchor(ctx: any): Promise<boolean> {
		if (!state.anchorEntryId) state.anchorEntryId = findAnchor(ctx)?.id ?? null;
		if (!state.anchorEntryId) {
			ctx.ui.notify("No loop anchor found", "error");
			await stopLoop(ctx);
			return false;
		}
		return navigateToEntry(state.anchorEntryId, ctx);
	}

	async function continueLoop(eventCtx: any, action: { type: "oversee"; summaryText?: string } | { type: "workhorse"; overseerText: string }): Promise<void> {
		const ctx = loopCommandCtx;
		if (!ctx) {
			eventCtx.ui.notify("Loop lost its command context", "error");
			await stopLoop(eventCtx);
			return;
		}
		await ctx.waitForIdle();
		if (action.type === "workhorse") await startWorkhorse(action.overseerText, ctx);
		else await startOverseer(ctx, action.summaryText);
	}

	async function setAgent(modelStr: string, thinking: string, ctx: any): Promise<boolean> {
		const model = findModel(modelStr, ctx);
		if (!model) { ctx.ui.notify(`Model not found: ${modelStr}`, "error"); await stopLoop(ctx); return false; }
		if (!await pi.setModel(model)) { ctx.ui.notify(`No API key for model: ${modelStr}`, "error"); await stopLoop(ctx); return false; }
		pi.setThinkingLevel(thinking);
		return true;
	}

	// ── Manual mode ─────────────────────────────────────

	// ── Plannotator integration ───────────────────────

	function detectPlannotator(cwd?: string): boolean {
		// Always re-check config (don't use cached value — config may have changed)
		const cfg = loadConfig(cwd || loopCommandCtx?.cwd || "");
		if (!cfg.plannotator) { state.hasPlannotator = false; return false; }
		if (state.hasPlannotator !== null) return state.hasPlannotator;
		if (!pi.events?.emit) { state.hasPlannotator = false; return false; }
		// Synchronous detection — plannotator's review-status handler responds synchronously
		let responded = false;
		pi.events.emit("plannotator:request", {
			requestId: `detect-${Date.now()}`,
			action: "review-status",
			payload: { reviewId: "__loop_detect__" },
			respond: () => { responded = true; },
		});
		state.hasPlannotator = responded;
		return responded;
	}

	/** Plannotator handles commit selection + diff + annotation. No git state mangling. */
	async function openPlannotator(ctx: any): Promise<{ approved: boolean; feedback?: string } | null> {
		return new Promise<{ approved: boolean; feedback?: string } | null>((resolve) => {
			pi.events.emit("plannotator:request", {
				requestId: `loop-review-${Date.now()}`,
				action: "code-review",
				payload: { diffType: "branch", cwd: ctx.cwd },
				respond: (response: any) => {
					if (response?.status === "handled" && response.result) resolve(response.result);
					else resolve(null);
				},
			});
		});
	}

	// ── Time tracking ───────────────────────────

	let pauseStartedAt = 0;

	function pauseTimer(): void {
		if (pauseStartedAt === 0) pauseStartedAt = Date.now();
	}

	function resumeTimer(): void {
		if (pauseStartedAt > 0) {
			state.pausedElapsed += Date.now() - pauseStartedAt;
			pauseStartedAt = 0;
		}
	}

	// ── Commit review UI ───────────────────────

	function recoverGitState(ctx: any): boolean {
		const gitIssue = checkGitState(ctx.cwd);
		if (!gitIssue) return true;
		const fixed = fixGitState(ctx.cwd, gitIssue);
		if (fixed) return true;
		if (gitIssue.type === "dirty_tree") return true; // warn-only, proceed
		ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually, then /loop:resume`, "error");
		return false;
	}

	async function advanceCommit(ctx: any): Promise<boolean> {
		if (state.currentCommitIdx >= state.commitList.length - 1) {
			ctx.ui.notify(`All ${state.commitList.length} commit(s) approved`, "success");
			await stopLoop(ctx);
			return false;
		}
		state.currentCommitIdx++;
		return true;
	}

	// Overridable for testing via pi.events
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (pi.events?.on) {
		pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	async function showCommitForReview(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await stopLoop(ctx); return; }

		while (true) {
			state.phase = "awaiting_feedback";
			const sha = state.commitList[state.currentCommitIdx];
			if (!sha) { await stopLoop(ctx); return; }
			const shortSha = sha.slice(0, 7);
			const subject = getCommitSubject(ctx.cwd, sha);
			statusPrefix = `Manual: ${shortSha} (${state.currentCommitIdx + 1}/${state.commitList.length})`;
			updateStatus(ctx);

			// Use the original editor saved before blockInteractiveEditors()
			const origEditor = savedEnv.EDITOR || savedEnv.VISUAL || process.env.EDITOR || process.env.VISUAL;
			const result = reviewFn(sha, ctx.cwd, origEditor);

			if (result.approved) {
				if (!await advanceCommit(ctx)) return;
				continue;
			}

			await startManualInnerLoop(result.feedback, ctx);
			return;
		}
	}

	async function startManualInnerLoop(feedback: string, ctx: any): Promise<void> {
		resumeTimer();
		state.userFeedback = feedback;
		state.round = 1;
		state.manualInnerRound = 0;
		state.workhorseSummaries = [];
		state.overseerLeafId = null;
		state.roundStartedAt = Date.now();

		const sha = state.commitList[state.currentCommitIdx];
		const overseerText = `[COMMIT:${sha}]\n${feedback}`;

		if (!await navigateToAnchor(ctx)) return;
		state.patchIdMap = buildPatchIdMap(ctx.cwd, state.commitList);
		await startWorkhorse(overseerText, ctx);
	}

	async function afterManualInnerLoop(ctx: any): Promise<void> {
		if (state.phase === "idle") return; // already stopped
		// Single commit review — inner loop done means we're done
		const useCtx = loopCommandCtx || ctx;
		await stopLoop(useCtx);
	}

	// ── Transitions ─────────────────────────────────────

	async function startOverseer(ctx: any, summaryText?: string): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		if (state.reviewMode === "fresh") {
			if (!await navigateToAnchor(ctx)) return;
		} else if (state.round > 1) {
			if (!state.overseerLeafId) {
				ctx.ui.notify("No loop branch to return to", "error");
				await stopLoop(ctx);
				return;
			}
			if (!await navigateToEntry(state.overseerLeafId, ctx)) return;
			if (summaryText) {
				pi.sendMessage({ customType: "workhorse-summary", content: summaryText, display: true }, { triggerTurn: false });
			}
		}
		if (!await setAgent(cfg.overseerModel, cfg.overseerThinking, ctx)) return;

		state.phase = "reviewing";
		state.roundStartedAt = Date.now();
		state.overseerLeafId = null;
		statusPrefix = `🔍 Round ${state.round}/${state.maxRounds} · ${state.reviewMode} · ${cfg.overseerModel} reviewing`;
		updateStatus(ctx);
		if (state.mode !== "manual") log(`[Round ${state.round}] Overseer: ${cfg.overseerModel} · mode: ${state.reviewMode} · started: ${formatTime(state.roundStartedAt)}`);
		const prompts = promptSets[state.mode];
		pi.sendUserMessage(prompts.buildOverseerPrompt({
			focus: state.focus, round: state.round, reviewMode: state.reviewMode,
			contextPaths: state.contextPaths, workhorseSummaries: state.workhorseSummaries,
			unchangedCommits: state.unchangedCommits,
			changedContextPaths: state.changedContextPaths,
			userFeedback: state.mode === "manual" ? state.userFeedback : undefined,
			commitSha: state.mode === "manual" && state.commitList.length > 0
				? state.commitList[state.currentCommitIdx] : undefined,
		}));
	}

	async function startWorkhorse(overseerText: string, ctx: any): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		state.overseerLeafId = ctx.sessionManager.getLeafId();
		if (!await navigateToAnchor(ctx)) return;

		// Snapshot patch-ids before workhorse runs (incremental review only)
		state.patchSnapshot = null;
		state.snapshotBase = "";
		state.taggedSubjects = [];
		state.unchangedCommits = [];
		state.contextHashes = null;
		state.changedContextPaths = [];
		if (state.mode === "review" && state.reviewMode === "incremental") {
			// Snapshot @path content hashes before workhorse modifies files
			if (state.contextPaths.length > 0) {
				state.contextHashes = snapshotContextHashes(state.contextPaths);
			}
			const taggedSHAs = extractTaggedSHAs(overseerText);
			if (taggedSHAs.length > 1) {
				const base = findSnapshotBase(ctx.cwd, taggedSHAs);
				if (base) {
					state.patchSnapshot = snapshotPatchIds(ctx.cwd, base);
					state.snapshotBase = base;
					state.taggedSubjects = resolveSubjects(ctx.cwd, taggedSHAs);
					log(`[Snapshot] ${state.taggedSubjects.length} tagged commits, ${state.patchSnapshot.size} in range`);
				}
			}
		}

		if (!await setAgent(cfg.workhorseModel, cfg.workhorseThinking, ctx)) return;

		state.phase = "fixing";
		const rr = state.roundResults.find(r => r.round === state.round);
		if (rr) rr.workhorseStartedAt = Date.now();
		statusPrefix = `🔧 Round ${state.round}/${state.maxRounds} · ${state.reviewMode} · ${cfg.workhorseModel} fixing`;
		updateStatus(ctx);
		if (state.mode !== "manual") log(`[Round ${state.round}] Workhorse: ${cfg.workhorseModel}`);
		const prompts = promptSets[state.mode];
		// Manual mode: ensure commit SHA prefix is present
		let workhorseInput = overseerText;
		if (state.mode === "manual" && state.commitList.length > 0) {
			const sha = state.commitList[state.currentCommitIdx];
			if (!workhorseInput.startsWith("[COMMIT:")) {
				workhorseInput = `[COMMIT:${sha}]\n${workhorseInput}`;
			}
		}
		const cfg2 = loadConfig(ctx.cwd);
		pi.sendUserMessage(prompts.buildWorkhorsePrompt(workhorseInput, state.contextPaths, state.round, { rewriteHistory: cfg2.rewriteHistory }));
	}

	async function onWorkhorseDone(workhorseText: string, eventCtx: any): Promise<void> {
		const summary = sanitize(stripVerdict(workhorseText));
		const summaryText = `[Workhorse Round ${state.round}] ${summary}`;
		state.workhorseSummaries.push(summaryText);
		recordWorkhorse(state.round, summaryText);
		if (state.mode !== "manual") log(`🔧 Workhorse done\n${summary}`);

		// Detect changed @path files
		if (state.contextHashes && state.contextPaths.length > 0) {
			state.changedContextPaths = findChangedContextPaths(state.contextPaths, state.contextHashes);
			if (state.changedContextPaths.length > 0) {
				log(`📄 Changed @paths: ${state.changedContextPaths.length}/${state.contextPaths.length}`);
			}
			state.contextHashes = null;
		}

		// Compare patch-ids to detect unchanged commits
		const cwd = loopCommandCtx?.cwd || eventCtx?.cwd;
		if (state.patchSnapshot && state.snapshotBase && state.taggedSubjects.length > 0 && cwd) {
			const after = snapshotPatchIds(cwd, state.snapshotBase);
			state.unchangedCommits = detectUnchanged(state.patchSnapshot, after, state.taggedSubjects);
			if (state.unchangedCommits.length > 0) {
				log(`⚠️ Unchanged commits: ${state.unchangedCommits.join(", ")}`);
			}
			state.patchSnapshot = null;
			state.snapshotBase = "";
			state.taggedSubjects = [];
		}

		const now = Date.now();
		const rr = state.roundResults.find(r => r.round === state.round);
		if (rr) rr.endedAt = now;
		if (state.mode !== "manual" && state.roundStartedAt) log(`⏱ Round ${state.round}: ${formatDuration(now - state.roundStartedAt)} (${formatTime(state.roundStartedAt)} → ${formatTime(now)})`);

		if (state.mode !== "manual") state.round++;
		await continueLoop(eventCtx, { type: "oversee", summaryText: state.reviewMode === "incremental" ? summaryText : undefined });
	}

	async function stopLoop(ctx: any): Promise<void> {
		const wasRunning = state.phase !== "idle";
		const mode = state.mode;

		// Set idle FIRST to prevent any deferred callbacks from running
		state.phase = "idle";

		// Clean up broken git state left by inner loop
		if (mode === "manual" && wasRunning) {
			const gitIssue = checkGitState(ctx.cwd);
			if (gitIssue) {
				if (!fixGitState(ctx.cwd, gitIssue) && gitIssue.type !== "dirty_tree") {
					ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually`, "warning");
				}
			}
		}

		resumeTimer();
		stopStatusTimer();
		state.overseerLeafId = null;
		loopCommandCtx = null;
		pauseStartedAt = 0;
		ctx.ui.setStatus("loop", "");
		restoreEditorEnv();
		if (!wasRunning || !state.originalModelStr) return;

		const model = findModel(state.originalModelStr, ctx);
		if (!model) { ctx.ui.notify(`Could not restore model: ${state.originalModelStr}`, "error"); return; }
		await pi.setModel(model);
		pi.setThinkingLevel(state.originalThinking);
		const elapsed = totalElapsed();
		if (elapsed > 1000) ctx.ui.notify(`Loop ended. ${formatDuration(elapsed)} elapsed.`, "info");
	}

	// ── agent_end ───────────────────────────────────────

	pi.on("agent_end", (_event, ctx) => {
		if (state.phase === "idle") return;
		const { text, stopReason } = getLastAssistant(ctx);
		if (stopReason === "abort" || stopReason === "aborted" || stopReason === "cancelled") return;

		if (state.phase === "reviewing") {
			if (!text.trim()) return;
			handleOverseerEnd(text, ctx);
		} else if (state.phase === "fixing") {
			handleWorkhorseEnd(text, ctx);
		}
	});

	function handleOverseerEnd(text: string, ctx: any): void {
		const verdict = matchVerdict(text);

		if (verdict === "approved") {
			recordOverseer(state.round, "approved", text);
			const now = Date.now();
			const rr = state.roundResults.find(r => r.round === state.round);
			if (rr) rr.endedAt = now;

			if (state.mode === "manual") {
				pauseTimer();
				deferIf("reviewing", () => void afterManualInnerLoop(ctx));
				return;
			}

			log(`✅ APPROVED`);
			if (state.roundStartedAt) log(`⏱ Round ${state.round}: ${formatDuration(now - state.roundStartedAt)} (${formatTime(state.roundStartedAt)} → ${formatTime(now)})`);
			deferIf("reviewing", () => { ctx.ui.notify(`✅ Approved after ${state.round} round(s)`, "success"); stopLoop(ctx); });
			return;
		}
		if (verdict === "changes_requested") {
			recordOverseer(state.round, "changes_requested", text);
			const summary = sanitize(stripVerdict(text));
			if (state.mode !== "manual") log(`❌ CHANGES REQUESTED\n${summary}`);
			if (state.mode === "manual") state.round++;
			deferIf("reviewing", () => {
				if (state.round >= state.maxRounds) { ctx.ui.notify(`Hit ${state.maxRounds} rounds without approval`, "warning"); void stopLoop(ctx); return; }
				void continueLoop(ctx, { type: "workhorse", overseerText: text });
			});
			return;
		}
		deferIf("reviewing", () => pi.sendUserMessage("Continue. When done, end with VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED"));
	}

	function handleWorkhorseEnd(text: string, ctx: any): void {
		if (hasFixesComplete(text)) {
			deferIf("fixing", () => void onWorkhorseDone(text, ctx));
			return;
		}
		deferIf("fixing", () => pi.sendUserMessage("Continue addressing the remaining issues. When all fixes are done, end with FIXES_COMPLETE"));
	}

	// ── Round tracking ──────────────────────────────────

	function recordOverseer(round: number, verdict: "approved" | "changes_requested", text: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) { r.verdict = verdict; r.overseerText = text; }
		else state.roundResults.push({ round, verdict, overseerText: text, workhorseSummary: "", startedAt: state.roundStartedAt, endedAt: 0, workhorseStartedAt: 0 });
	}

	function recordWorkhorse(round: number, summary: string): void {
		const r = state.roundResults.find(r => r.round === round);
		if (r) r.workhorseSummary = summary;
	}

	// ── Commands ────────────────────────────────────────

	async function startLoop(mode: LoopMode, args: string, ctx: any): Promise<void> {
		if (state.phase !== "idle") { ctx.ui.notify("Loop already running — /loop:stop to cancel", "warning"); return; }
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();
		const { focus, contextPaths } = parseArgs(trimmedArgs, ctx.cwd);
		loopCommandCtx = ctx;
		state = newState({
			mode, round: 1, focus, initialRequest: trimmedArgs || "(no focus specified)", contextPaths,
			maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
			originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
			loopStartedAt: Date.now(),
		});
		log(`📝 Request · Started: ${formatTime(state.loopStartedAt)}\n${state.initialRequest}`);
		rememberAnchor(ctx);
		blockInteractiveEditors();
		startStatusTimer(ctx);
		ctx.ui.notify(`Saving model: ${state.originalModelStr} · ${state.originalThinking}`, "info");
		await ctx.waitForIdle();
		await startOverseer(ctx);
	}

	pi.registerCommand("loop", {
		description: "Start loop. Usage: /loop [focus] [@path ...]",
		handler: (args, ctx) => startLoop("review", args, ctx),
	});

	pi.registerCommand("loop:exec", {
		description: "Start exec loop (orchestrator → workhorse). Usage: /loop:exec [focus] [@path ...]",
		handler: (args, ctx) => startLoop("exec", args, ctx),
	});

	pi.registerCommand("loop:manual", {
		description: "Manual review. Usage: /loop:manual [sha]",
		handler: async (args, ctx) => {
			if (state.phase !== "idle") { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return; }
			const cfg = loadConfig(ctx.cwd);
			const trimmedArgs = (args || "").trim();

			// Plannotator: delegate everything (commit selection, diff, annotation)
			if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
				loopCommandCtx = ctx;
				state = newState({
					mode: "manual", phase: "awaiting_feedback", round: 0,
					focus: "manual review", initialRequest: "manual review",
					contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
					originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
					loopStartedAt: Date.now(),
				});
				rememberAnchor(ctx);
				blockInteractiveEditors();
				startStatusTimer(ctx);
				ctx.ui.notify("Opening plannotator...", "info");
				const result = await openPlannotator(ctx);
				if (!result || result.approved) {
					ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
					await stopLoop(ctx);
					return;
				}
				if (result.feedback) {
					await startManualInnerLoop(result.feedback, ctx);
				}
				return;
			}

			// Editor path: pick a single commit, review in $EDITOR
			let commit: string;
			let resolvedBase: string;

			if (trimmedArgs) {
				// Explicit SHA given
				try {
					commit = execSync(`git rev-parse ${trimmedArgs}`, { ...GIT_OPTS, cwd: ctx.cwd }).trim();
				} catch {
					ctx.ui.notify(`Could not resolve: ${trimmedArgs}`, "error");
					return;
				}
			} else {
				const picked = await pickSingleCommit(ctx);
				if (!picked) return;
				commit = picked;
			}

			try {
				resolvedBase = execSync(`git rev-parse ${commit}~1`, { ...GIT_OPTS, cwd: ctx.cwd }).trim();
			} catch {
				resolvedBase = commit;
			}

			loopCommandCtx = ctx;
			state = newState({
				mode: "manual", phase: "awaiting_feedback", round: 0,
				focus: `manual review: ${commit.slice(0, 7)}`,
				initialRequest: `manual review: ${commit.slice(0, 7)}`,
				contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
				loopStartedAt: Date.now(),
				commitList: [commit], currentCommitIdx: 0,
				patchIdMap: buildPatchIdMap(ctx.cwd, [commit]),
				manualBase: resolvedBase,
			});

			rememberAnchor(ctx);
			blockInteractiveEditors();
			pauseTimer(); // timer starts paused — only counts inner loop time
			startStatusTimer(ctx);
			await showCommitForReview(ctx);
		},
	});


	async function pickSingleCommit(ctx: any): Promise<string | null> {
		let range: string;
		try { range = resolveRange(ctx.cwd, ""); } catch { range = "HEAD~50..HEAD"; }

		let branchShas: string[];
		try {
			branchShas = execSync(`git log --format=%H ${range}`, { ...GIT_OPTS, cwd: ctx.cwd }).trim().split("\n").filter(Boolean);
		} catch {
			ctx.ui.notify("Could not list commits", "error");
			return null;
		}
		if (branchShas.length === 0) { ctx.ui.notify("No commits on this branch", "error"); return null; }

		const items = branchShas.map(s => `${s.slice(0, 7)} ${getCommitSubject(ctx.cwd, s)}`);
		const picked = await ctx.ui.select("Pick a commit to review", items);
		if (!picked) return null;
		const idx = items.indexOf(picked);
		return idx >= 0 ? branchShas[idx] : null;
	}

	pi.registerCommand("loop:resume", {
		description: "Resume loop from session state",
		handler: async (_args, ctx) => {
			if (state.phase !== "idle") { ctx.ui.notify("Loop already running", "warning"); return; }
			const anchor = findAnchor(ctx);

			// Manual mode resume — bypasses reconstructState entirely
			if (anchor?.data?.mode === "manual" && Array.isArray(anchor.data.commitList)) {
				const commits: string[] = anchor.data.commitList;
				// Verify commits still exist
				for (const sha of commits) {
					try {
						execSync(`git cat-file -t ${sha}`, { ...GIT_OPTS, cwd: ctx.cwd });
					} catch {
						ctx.ui.notify(`Commit ${sha.slice(0, 7)} no longer exists — cannot resume`, "error");
						return;
					}
				}
				const cfg = loadConfig(ctx.cwd);
				loopCommandCtx = ctx;
				state = newState({
					mode: "manual",
					phase: "awaiting_feedback",
					reviewMode: "incremental",
					focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
					initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
					contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
					maxRounds: cfg.maxRounds,
					originalModelStr: modelToStr(ctx.model),
					originalThinking: pi.getThinkingLevel(),
					anchorEntryId: anchor.id,
					loopStartedAt: Date.now(),
					commitList: commits,
					currentCommitIdx: anchor.data.currentCommitIdx ?? 0,
					patchIdMap: buildPatchIdMap(ctx.cwd, commits),
					manualBase: anchor.data.manualBase ?? "",
				});
				blockInteractiveEditors();
				startStatusTimer(ctx);
				ctx.ui.notify(`Resuming manual review — commit ${state.currentCommitIdx + 1}/${commits.length}`, "info");
				await showCommitForReview(ctx);
				return;
			}

			const recovered = reconstructState(ctx);
			if (!recovered) { ctx.ui.notify("Nothing to resume. Use /loop to start.", "info"); return; }
			const cfg = loadConfig(ctx.cwd);
			loopCommandCtx = ctx;
			state = newState({
				round: recovered.round,
				focus: anchor?.data?.focus ?? recovered.focus,
				initialRequest: anchor?.data?.initialRequest ?? (recovered.focus || "(no focus specified)"),
				contextPaths: Array.isArray(anchor?.data?.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds, reviewMode: cfg.reviewMode,
				originalModelStr: modelToStr(ctx.model), originalThinking: pi.getThinkingLevel(),
				overseerLeafId: recovered.overseerLeafId,
				anchorEntryId: anchor?.id ?? null,
				loopStartedAt: Date.now(),
			});
			blockInteractiveEditors();
			startStatusTimer(ctx);
			ctx.ui.notify(`Resuming round ${recovered.round} (${recovered.phase} phase)`, "info");
			await ctx.waitForIdle();
			if (recovered.phase === "workhorse" && recovered.lastOverseerText) await startWorkhorse(recovered.lastOverseerText, ctx);
			else await startOverseer(ctx);
		},
	});

	pi.registerCommand("loop:stop", {
		description: "Stop the loop",
		handler: async (_args, ctx) => {
			if (state.phase === "idle") { ctx.ui.notify("No loop running", "info"); return; }
			ctx.ui.notify("Loop stopped", "info");
			await stopLoop(ctx);
		},
	});

	pi.registerCommand("loop:rounds", {
		description: "Change max rounds: /loop:rounds <n>",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			if (isNaN(num) || num < 1) {
				ctx.ui.notify(`Current max rounds: ${state.phase !== "idle" ? state.maxRounds : loadConfig(ctx.cwd).maxRounds}. Usage: /loop:rounds <n>`, "info");
				return;
			}
			state.maxRounds = num;
			saveConfigField("maxRounds", num);
			if (state.phase !== "idle") ctx.ui.setStatus("loop", `${state.phase === "reviewing" ? "🔍" : "🔧"} Round ${state.round}/${num}`);
			ctx.ui.notify(`Max rounds → ${num}`, "success");
		},
	});

	pi.registerCommand("loop:log", {
		description: "Browse overseer + workhorse logs in a modal viewer",
		handler: async (_args, ctx) => {
			if (state.roundResults.length === 0 && !state.initialRequest) { ctx.ui.notify("No loop rounds recorded yet.", "info"); return; }
			await showLog(state.initialRequest, state.roundResults, ctx, state.loopStartedAt);
		},
	});

	pi.registerCommand("loop:debug", {
		description: "Simulate a 3-round review loop and open the log viewer",
		handler: async (_args, ctx) => {
			const rounds = [
				{
					overseer: [
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
					workhorse: [
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
					overseer: [
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
					workhorse: [
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
					overseer: [
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
					workhorse: "",
				},
			];

			// Feed through the real state machinery with fake timing
			const now = Date.now();
			const roundDurations = [18 * 60000, 12 * 60000, 7 * 60000]; // 18m, 12m, 7m
			let elapsed = 0;
			for (const d of roundDurations) elapsed += d;
			state = newState({ initialRequest: "fix race condition in connection handler @internal/server/conn.go", loopStartedAt: now - elapsed });
			let cursor = now - elapsed;
			for (let i = 0; i < rounds.length; i++) {
				const r = rounds[i];
				state.round++;
				state.roundStartedAt = cursor;
				const verdict = matchVerdict(r.overseer);
				if (verdict) recordOverseer(state.round, verdict, r.overseer);
				if (r.workhorse) {
					const summary = `[Workhorse Round ${state.round}] ${sanitize(stripVerdict(r.workhorse))}`;
					recordWorkhorse(state.round, summary);
				}
				const rr = state.roundResults.find(rr => rr.round === state.round);
				if (rr) {
					if (r.workhorse) rr.workhorseStartedAt = cursor + Math.floor(roundDurations[i] * 0.4);
					rr.endedAt = cursor + roundDurations[i];
				}
				cursor += roundDurations[i];
			}
			await showLog(state.initialRequest, state.roundResults, ctx, state.loopStartedAt);
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
					// Reset detection cache so next manual loop re-probes
					state.hasPlannotator = null;
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
