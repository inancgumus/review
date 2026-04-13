/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: session construction, commit selection, editor review, inner-round
 * kickoff, status display, plannotator integration, COMMIT prefix protocol.
 * Engine owns: loop lifecycle, timing, model switching, navigation, state.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { LoopState } from "./engine.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** Engine primitives — manual composes these into manual-specific flows. */
interface ManualDeps {
	pi: ExtensionAPI;
	initLoop(overrides: Partial<LoopState>, ctx: any, opts?: {
		pauseTimer?: boolean;
		hooks?: {
			onApproved?(ctx: any): void;
			onChangesRequested?(text: string, ctx: any): void;
			suppressRoundIncrement?: boolean;
			suppressLogs?: boolean;
		};
	}): boolean;
	stopLoop(ctx: any): Promise<void>;
	navigateToAnchor(ctx: any): Promise<boolean>;
	startWorkhorse(text: string, ctx: any): Promise<void>;
	pauseTimer(): void;
	resumeTimer(): void;
	getState(): LoopState;
	getSavedEditorEnv(): Record<string, string | undefined>;
	modelToStr(model: any): string;
	setStatusPrefix(prefix: string): void;
}

export function createManualMode(engine: ManualDeps) {
	let originalEditor: string | undefined;
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (engine.pi.events?.on) {
		engine.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Session construction (manual-specific) ──────

	function initManualSession(init: {
		focus: string; initialRequest: string; contextPaths: string[];
		maxRounds: number; loopStartedAt: number;
		commitList?: string[]; currentCommitIdx?: number; anchorEntryId?: string;
		pauseTimer?: boolean; onApproved?(ctx: any): void;
	}, ctx: any): boolean {
		const ok = engine.initLoop({
			mode: "manual",
			phase: "awaiting_feedback",
			round: 0,
			reviewMode: "incremental",
			focus: init.focus,
			initialRequest: init.initialRequest,
			contextPaths: init.contextPaths,
			maxRounds: init.maxRounds,
			loopStartedAt: init.loopStartedAt,
			commitList: init.commitList ?? [],
			currentCommitIdx: init.currentCommitIdx ?? 0,
			anchorEntryId: init.anchorEntryId ?? null,
			originalModelStr: engine.modelToStr(ctx.model),
			originalThinking: engine.pi.getThinkingLevel(),
		}, ctx, {
			pauseTimer: init.pauseTimer,
			hooks: {
				onApproved(innerCtx: any) {
					engine.pauseTimer();
					if (init.onApproved) init.onApproved(innerCtx);
				},
				onChangesRequested() { engine.getState().round++; },
				suppressRoundIncrement: true,
				suppressLogs: true,
			},
		});
		if (!ok) return false;
		const env = engine.getSavedEditorEnv();
		originalEditor = env.EDITOR || env.VISUAL;
		return true;
	}

	// ── Inner-round kickoff (manual-specific) ───────

	async function beginInnerRound(feedback: string, ctx: any): Promise<void> {
		engine.resumeTimer();
		const state = engine.getState();
		state.userFeedback = feedback;
		state.round = 1;
		state.workhorseSummaries = [];
		state.overseerLeafId = null;
		state.roundStartedAt = Date.now();

		// COMMIT prefix protocol — manual-specific framing
		const sha = state.commitList[state.currentCommitIdx];
		const overseerText = sha ? `[COMMIT:${sha}]\n${feedback}` : feedback;

		if (!await engine.navigateToAnchor(ctx)) return;
		await engine.startWorkhorse(overseerText, ctx);
	}

	// ── Status display (manual-specific) ────────────

	function updateManualStatus(): void {
		const state = engine.getState();
		if (state.commitList.length > 0) {
			const sha = state.commitList[state.currentCommitIdx];
			if (sha) engine.setStatusPrefix(`Manual: ${sha.slice(0, 7)} (${state.currentCommitIdx + 1}/${state.commitList.length})`);
		}
	}

	// ── Plannotator integration ─────────────────────

	let plannotatorAvailable: boolean | null = null;

	function detectPlannotator(cwd?: string): boolean {
		const cfg = loadConfig(cwd || "");
		if (!cfg.plannotator) { plannotatorAvailable = false; return false; }
		if (plannotatorAvailable !== null) return plannotatorAvailable;
		if (!engine.pi.events?.emit) { plannotatorAvailable = false; return false; }
		let responded = false;
		engine.pi.events.emit("plannotator:request", {
			requestId: `detect-${Date.now()}`,
			action: "review-status",
			payload: { reviewId: "__loop_detect__" },
			respond: () => { responded = true; },
		});
		plannotatorAvailable = responded;
		return responded;
	}

	async function openPlannotator(ctx: any): Promise<{ approved: boolean; feedback?: string } | null> {
		return new Promise<{ approved: boolean; feedback?: string } | null>((resolve) => {
			engine.pi.events.emit("plannotator:request", {
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

	// ── Commit review UI ────────────────────────────

	async function reviewCommitLoop(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await engine.stopLoop(ctx); return; }

		while (true) {
			const state = engine.getState();
			state.phase = "awaiting_feedback";
			updateManualStatus();

			const sha = state.commitList[state.currentCommitIdx];
			if (!sha) { await engine.stopLoop(ctx); return; }

			const result = reviewFn(sha, ctx.cwd, originalEditor);

			if (result.approved) {
				if (state.currentCommitIdx >= state.commitList.length - 1) {
					ctx.ui.notify(`All ${state.commitList.length} commit(s) approved`, "success");
					await engine.stopLoop(ctx);
					return;
				}
				state.currentCommitIdx++;
				continue;
			}

			await beginInnerRound(result.feedback, ctx);
			return;
		}
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		await engine.stopLoop(ctx);
	}

	// ── Commit resolution ───────────────────────────

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
		plannotatorAvailable = null;
		ctx.cwd = git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// Plannotator: delegate everything (commit selection, diff, annotation)
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			if (!initManualSession({
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds,
				loopStartedAt: Date.now(),
				onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
			}, ctx)) return;
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await engine.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await beginInnerRound(result.feedback, ctx);
			}
			return;
		}

		// Editor path: pick a single commit, review in $EDITOR
		let commit: string;

		if (trimmedArgs) {
			const resolved = resolveCommit(trimmedArgs, ctx.cwd);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${trimmedArgs}`, "error"); return; }
			commit = resolved.commit;
		} else {
			const picked = await pickSingleCommit(ctx);
			if (!picked) return;
			const resolved = resolveCommit(picked, ctx.cwd);
			if (!resolved) { ctx.ui.notify(`Could not resolve: ${picked}`, "error"); return; }
			commit = resolved.commit;
		}

		if (!initManualSession({
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds,
			loopStartedAt: Date.now(),
			commitList: [commit], currentCommitIdx: 0,
			pauseTimer: true,
			onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
		}, ctx)) return;

		await reviewCommitLoop(ctx);
	}

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
		plannotatorAvailable = null;
		ctx.cwd = anchor.data.cwd || git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
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
			if (!initManualSession({
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				anchorEntryId: anchor.id,
				loopStartedAt: Date.now(),
				commitList: commits,
				currentCommitIdx: anchor.data.currentCommitIdx ?? 0,
				onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
			}, ctx)) return;
			const state = engine.getState();
			ctx.ui.notify(`Resuming manual review — commit ${state.currentCommitIdx + 1}/${commits.length}`, "info");
			await reviewCommitLoop(ctx);
			return;
		}

		// Plannotator-backed manual session: verify plannotator is still available
		if (!detectPlannotator(ctx.cwd)) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		if (!initManualSession({
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			anchorEntryId: anchor.id,
			loopStartedAt: Date.now(),
			onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
		}, ctx)) return;
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await engine.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await beginInnerRound(result.feedback, ctx);
		}
	}

	return { start, resume };
}
