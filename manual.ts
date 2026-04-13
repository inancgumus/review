/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Extracted from engine.ts to keep the main state machine focused on shared loop logic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ModeHooks } from "./types.js";
import type { LoopState } from "./types.js";
import { newState } from "./types.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

// Dependencies injected by the engine
interface ManualDeps {
	pi: ExtensionAPI;
	getState(): LoopState;
	setState(s: LoopState): void;
	getLoopCommandCtx(): any;
	setLoopCommandCtx(ctx: any): void;
	setStatusPrefix(prefix: string): void;
	getSavedEditorEnv(): Record<string, string | undefined>;
	stopLoop(ctx: any): Promise<void>;
	navigateToAnchor(ctx: any): Promise<boolean>;
	startWorkhorse(text: string, ctx: any): Promise<void>;
	updateStatus(ctx: any): void;
	startStatusTimer(ctx: any): void;
	rememberAnchor(ctx: any): void;
	blockInteractiveEditors(): void;
	log(text: string): void;
	pauseTimer(): void;
	resumeTimer(): void;
	modelToStr(model: any): string;
	setModeHooks(hooks: ModeHooks): void;
}

interface ManualMode {
	start(args: string, ctx: any): Promise<void>;
	resume(ctx: any, anchor: { id: string; data: any }): Promise<void>;
}

export function createManualMode(deps: ManualDeps): ManualMode {
	// Overridable for testing via pi.events
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (deps.pi.events?.on) {
		deps.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Plannotator integration ─────────────────────

	function detectPlannotator(cwd?: string): boolean {
		const state = deps.getState();
		const cfg = loadConfig(cwd || deps.getLoopCommandCtx()?.cwd || "");
		if (!cfg.plannotator) { state.hasPlannotator = false; return false; }
		if (state.hasPlannotator !== null) return state.hasPlannotator;
		if (!deps.pi.events?.emit) { state.hasPlannotator = false; return false; }
		let responded = false;
		deps.pi.events.emit("plannotator:request", {
			requestId: `detect-${Date.now()}`,
			action: "review-status",
			payload: { reviewId: "__loop_detect__" },
			respond: () => { responded = true; },
		});
		state.hasPlannotator = responded;
		return responded;
	}

	async function openPlannotator(ctx: any): Promise<{ approved: boolean; feedback?: string } | null> {
		return new Promise<{ approved: boolean; feedback?: string } | null>((resolve) => {
			deps.pi.events.emit("plannotator:request", {
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

	// ── Git state recovery ──────────────────────────

	function recoverGitState(ctx: any): boolean {
		const gitIssue = git.checkGitState(ctx.cwd);
		if (!gitIssue) return true;
		const fixed = git.fixGitState(ctx.cwd, gitIssue);
		if (fixed) return true;
		if (gitIssue.type === "dirty_tree") return true;
		ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually, then /loop:resume`, "error");
		return false;
	}

	async function advanceCommit(ctx: any): Promise<boolean> {
		const state = deps.getState();
		if (state.currentCommitIdx >= state.commitList.length - 1) {
			ctx.ui.notify(`All ${state.commitList.length} commit(s) approved`, "success");
			await deps.stopLoop(ctx);
			return false;
		}
		state.currentCommitIdx++;
		return true;
	}

	// ── Commit review UI ────────────────────────────

	async function showCommitForReview(ctx: any): Promise<void> {
		const state = deps.getState();
		if (!recoverGitState(ctx)) { await deps.stopLoop(ctx); return; }

		while (true) {
			state.phase = "awaiting_feedback";
			const sha = state.commitList[state.currentCommitIdx];
			if (!sha) { await deps.stopLoop(ctx); return; }
			const shortSha = sha.slice(0, 7);
			const subject = git.getCommitSubject(ctx.cwd, sha);
			deps.setStatusPrefix(`Manual: ${shortSha} (${state.currentCommitIdx + 1}/${state.commitList.length})`);
			deps.updateStatus(ctx);

			const savedEnv = deps.getSavedEditorEnv();
			const origEditor = savedEnv.EDITOR || savedEnv.VISUAL || process.env.EDITOR || process.env.VISUAL;
			const result = reviewFn(sha, ctx.cwd, origEditor);

			if (result.approved) {
				if (!await advanceCommit(ctx)) return;
				continue;
			}

			await startInnerLoop(result.feedback, ctx);
			return;
		}
	}

	async function startInnerLoop(feedback: string, ctx: any): Promise<void> {
		const state = deps.getState();
		deps.resumeTimer();
		state.userFeedback = feedback;
		state.round = 1;
		state.workhorseSummaries = [];
		state.overseerLeafId = null;
		state.roundStartedAt = Date.now();

		const sha = state.commitList[state.currentCommitIdx];
		const overseerText = sha ? `[COMMIT:${sha}]\n${feedback}` : feedback;

		if (!await deps.navigateToAnchor(ctx)) return;
		await deps.startWorkhorse(overseerText, ctx);
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		const state = deps.getState();
		if (state.phase === "idle") return;
		const useCtx = deps.getLoopCommandCtx() || ctx;
		await deps.stopLoop(useCtx);
	}

	// ── Init helpers ────────────────────────────────

	function initManual(overrides: Partial<LoopState>, ctx: any, opts?: { pauseTimer?: boolean }): void {
		deps.setLoopCommandCtx(ctx);
		deps.setState(newState(overrides));
		deps.rememberAnchor(ctx);
		deps.blockInteractiveEditors();
		if (opts?.pauseTimer) deps.pauseTimer();
		deps.startStatusTimer(ctx);
		deps.setModeHooks({
			onApproved(innerCtx: any) {
				deps.pauseTimer();
				void afterInnerLoop(innerCtx);
			},
			onChangesRequested() {
				deps.getState().round++;
			},
			suppressRoundIncrement: true,
			suppressLogs: true,
		});
	}

	function resolveCommit(sha: string, cwd: string): { commit: string; base: string } | null {
		let commit: string;
		try {
			commit = execSync(`git rev-parse ${sha}`, { ...GIT_OPTS, cwd }).trim();
		} catch {
			return null;
		}
		let base: string;
		try {
			base = execSync(`git rev-parse ${commit}~1`, { ...GIT_OPTS, cwd }).trim();
		} catch {
			base = commit;
		}
		return { commit, base };
	}

	async function pickSingleCommit(ctx: any): Promise<string | null> {
		let range: string;
		try { range = git.resolveRange(ctx.cwd, ""); } catch { range = "HEAD~50..HEAD"; }

		let branchShas: string[];
		try {
			branchShas = execSync(`git log --format=%H ${range}`, { ...GIT_OPTS, cwd: ctx.cwd }).trim().split("\n").filter(Boolean);
		} catch {
			ctx.ui.notify("Could not list commits", "error");
			return null;
		}
		if (branchShas.length === 0) { ctx.ui.notify("No commits on this branch", "error"); return null; }

		const items = branchShas.map(s => `${s.slice(0, 7)} ${git.getCommitSubject(ctx.cwd, s)}`);
		const picked = await ctx.ui.select("Pick a commit to review", items);
		if (!picked) return null;
		const idx = items.indexOf(picked);
		return idx >= 0 ? branchShas[idx] : null;
	}

	// ── Entry points ────────────────────────────────

	async function start(args: string, ctx: any): Promise<void> {
		const state = deps.getState();
		if (state.phase !== "idle") { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return; }
		ctx.cwd = git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// Plannotator: delegate everything (commit selection, diff, annotation)
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			initManual({
				mode: "manual", phase: "awaiting_feedback", round: 0,
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
				originalModelStr: deps.modelToStr(ctx.model), originalThinking: deps.pi.getThinkingLevel(),
				loopStartedAt: Date.now(),
			}, ctx);
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await deps.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await startInnerLoop(result.feedback, ctx);
			}
			return;
		}

		// Editor path: pick a single commit, review in $EDITOR
		let commit: string;
		let resolvedBase: string;

		if (trimmedArgs) {
			const resolved = resolveCommit(trimmedArgs, ctx.cwd);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${trimmedArgs}`, "error"); return; }
			commit = resolved.commit;
			resolvedBase = resolved.base;
		} else {
			const picked = await pickSingleCommit(ctx);
			if (!picked) return;
			const resolved = resolveCommit(picked, ctx.cwd);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${picked}`, "error"); return; }
			commit = resolved.commit;
			resolvedBase = resolved.base;
		}

		initManual({
			mode: "manual", phase: "awaiting_feedback", round: 0,
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
			originalModelStr: deps.modelToStr(ctx.model), originalThinking: deps.pi.getThinkingLevel(),
			loopStartedAt: Date.now(),
			commitList: [commit], currentCommitIdx: 0,
		}, ctx, { pauseTimer: true });

		await showCommitForReview(ctx);
	}

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
		const cfg = loadConfig(ctx.cwd);
		const commits: string[] = Array.isArray(anchor.data.commitList) ? anchor.data.commitList : [];

		// Commit-backed manual session: verify commits still exist
		if (commits.length > 0) {
			for (const sha of commits) {
				try {
					execSync(`git cat-file -t ${sha}`, { ...GIT_OPTS, cwd: ctx.cwd });
				} catch {
					ctx.ui.notify(`Commit ${sha.slice(0, 7)} no longer exists — cannot resume`, "error");
					return;
				}
			}
			initManual({
				mode: "manual",
				phase: "awaiting_feedback",
				reviewMode: "incremental",
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				originalModelStr: deps.modelToStr(ctx.model),
				originalThinking: deps.pi.getThinkingLevel(),
				anchorEntryId: anchor.id,
				loopStartedAt: Date.now(),
				commitList: commits,
				currentCommitIdx: anchor.data.currentCommitIdx ?? 0,
			}, ctx);
			ctx.ui.notify(`Resuming manual review — commit ${deps.getState().currentCommitIdx + 1}/${commits.length}`, "info");
			await showCommitForReview(ctx);
			return;
		}

		// Plannotator-backed manual session: restore state and re-open plannotator
		initManual({
			mode: "manual",
			phase: "awaiting_feedback",
			reviewMode: "incremental",
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			originalModelStr: deps.modelToStr(ctx.model),
			originalThinking: deps.pi.getThinkingLevel(),
			anchorEntryId: anchor.id,
			loopStartedAt: Date.now(),
		}, ctx);
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await deps.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await startInnerLoop(result.feedback, ctx);
		}
	}

	return { start, resume };
}
