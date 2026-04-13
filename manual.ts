/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: commit selection, editor review, plannotator integration.
 * Engine owns: loop lifecycle, timing, status, model switching.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ModeHooks, LoopState } from "./types.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** Narrow interface — manual.ts only knows these high-level engine operations. */
interface ManualDeps {
	pi: ExtensionAPI;
	engine: {
		state: LoopState;
		prepareLoop(overrides: Partial<LoopState>, ctx: any, hooks: ModeHooks, opts?: { pauseTimer?: boolean }): { originalEditor: string | undefined };
		stopLoop(ctx: any): Promise<void>;
		startWorkhorse(text: string, ctx: any): Promise<void>;
	};
}

interface ManualMode {
	start(args: string, ctx: any): Promise<void>;
	resume(ctx: any, anchor: { id: string; data: any }): Promise<void>;
}

export function createManualMode(deps: ManualDeps): ManualMode {
	let originalEditor: string | undefined;
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (deps.pi.events?.on) {
		deps.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Plannotator integration ─────────────────────

	function detectPlannotator(cwd?: string): boolean {
		const state = deps.engine.state;
		const cfg = loadConfig(cwd || "");
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
		const state = deps.engine.state;
		if (state.currentCommitIdx >= state.commitList.length - 1) {
			ctx.ui.notify(`All ${state.commitList.length} commit(s) approved`, "success");
			await deps.engine.stopLoop(ctx);
			return false;
		}
		state.currentCommitIdx++;
		return true;
	}

	// ── Commit review UI ────────────────────────────

	async function showCommitForReview(ctx: any): Promise<void> {
		const state = deps.engine.state;
		if (!recoverGitState(ctx)) { await deps.engine.stopLoop(ctx); return; }

		while (true) {
			state.phase = "awaiting_feedback";
			const sha = state.commitList[state.currentCommitIdx];
			if (!sha) { await deps.engine.stopLoop(ctx); return; }

			const result = reviewFn(sha, ctx.cwd, originalEditor);

			if (result.approved) {
				if (!await advanceCommit(ctx)) return;
				continue;
			}

			await startInnerLoop(result.feedback, ctx);
			return;
		}
	}

	async function startInnerLoop(feedback: string, ctx: any): Promise<void> {
		const state = deps.engine.state;
		state.userFeedback = feedback;
		state.round = 1;
		state.workhorseSummaries = [];
		state.overseerLeafId = null;
		state.roundStartedAt = Date.now();

		const sha = state.commitList[state.currentCommitIdx];
		const overseerText = sha ? `[COMMIT:${sha}]\n${feedback}` : feedback;

		await deps.engine.startWorkhorse(overseerText, ctx);
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		if (deps.engine.state.phase === "idle") return;
		await deps.engine.stopLoop(ctx);
	}

	function buildModeHooks(): ModeHooks {
		return {
			onApproved(ctx: any) {
				void afterInnerLoop(ctx);
			},
			onChangesRequested() {
				deps.engine.state.round++;
			},
			suppressRoundIncrement: true,
			suppressLogs: true,
		};
	}

	// ── Commit resolution ───────────────────────────

	function prepare(overrides: Partial<LoopState>, ctx: any, opts?: { pauseTimer?: boolean }): void {
		const result = deps.engine.prepareLoop(overrides, ctx, buildModeHooks(), opts);
		originalEditor = result.originalEditor;
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
		if (deps.engine.state.phase !== "idle") { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return; }
		ctx.cwd = git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// Plannotator: delegate everything (commit selection, diff, annotation)
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			prepare({
				mode: "manual", phase: "awaiting_feedback", round: 0,
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
				loopStartedAt: Date.now(),
			}, ctx);
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await deps.engine.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await startInnerLoop(result.feedback, ctx);
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

		prepare({
			mode: "manual", phase: "awaiting_feedback", round: 0,
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds, reviewMode: "incremental",
			loopStartedAt: Date.now(),
			commitList: [commit], currentCommitIdx: 0,
		}, ctx, { pauseTimer: true });

		await showCommitForReview(ctx);
	}

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
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
			prepare({
				mode: "manual",
				phase: "awaiting_feedback",
				reviewMode: "incremental",
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				anchorEntryId: anchor.id,
				loopStartedAt: Date.now(),
				commitList: commits,
				currentCommitIdx: anchor.data.currentCommitIdx ?? 0,
			}, ctx);
			ctx.ui.notify(`Resuming manual review — commit ${deps.engine.state.currentCommitIdx + 1}/${commits.length}`, "info");
			await showCommitForReview(ctx);
			return;
		}

		// Plannotator-backed manual session: verify plannotator is still available
		if (!detectPlannotator(ctx.cwd)) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		prepare({
			mode: "manual",
			phase: "awaiting_feedback",
			reviewMode: "incremental",
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			anchorEntryId: anchor.id,
			loopStartedAt: Date.now(),
		}, ctx);
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await deps.engine.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await startInnerLoop(result.feedback, ctx);
		}
	}

	return { start, resume };
}
