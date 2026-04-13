/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: commit selection, editor review, plannotator integration.
 * Engine owns: loop lifecycle, timing, status, model switching, state.
 *
 * manual.ts treats the engine as opaque — it reads through accessors
 * and writes through semantic operations, never touching LoopState directly.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** What manual.ts needs from the engine — semantic, not structural. */
export interface ManualEngineAPI {
	pi: ExtensionAPI;

	// Read-only accessors
	readonly isIdle: boolean;
	readonly phase: string;
	readonly commitList: readonly string[];
	readonly currentCommitIdx: number;

	// Session lifecycle
	initManualSession(init: ManualSessionInit, ctx: any): { originalEditor: string | undefined };
	stopLoop(ctx: any): Promise<void>;

	// State transitions — semantic operations, not raw field writes
	awaitFeedback(): void;
	advanceCommit(): boolean;        // returns false when all commits done
	cachePlannotator(v: boolean): void;
	beginInnerRound(feedback: string, ctx: any): Promise<void>;
}

/** Declarative session init — no LoopState knowledge needed. */
export interface ManualSessionInit {
	focus: string;
	initialRequest: string;
	contextPaths: string[];
	maxRounds: number;
	loopStartedAt: number;
	commitList?: string[];
	currentCommitIdx?: number;
	anchorEntryId?: string;
	pauseTimer?: boolean;
	onApproved?(ctx: any): void;
}

export interface ManualMode {
	start(args: string, ctx: any): Promise<void>;
	resume(ctx: any, anchor: { id: string; data: any }): Promise<void>;
}

export function createManualMode(deps: ManualEngineAPI): ManualMode {
	let originalEditor: string | undefined;
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (deps.pi.events?.on) {
		deps.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Plannotator integration ─────────────────────

	function detectPlannotator(cwd?: string): boolean {
		const cfg = loadConfig(cwd || "");
		if (!cfg.plannotator) { deps.cachePlannotator(false); return false; }
		// Use cached result if available (engine stores it)
		// We can't read hasPlannotator directly — but we can probe again
		if (!deps.pi.events?.emit) { deps.cachePlannotator(false); return false; }
		let responded = false;
		deps.pi.events.emit("plannotator:request", {
			requestId: `detect-${Date.now()}`,
			action: "review-status",
			payload: { reviewId: "__loop_detect__" },
			respond: () => { responded = true; },
		});
		deps.cachePlannotator(responded);
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
		if (!deps.advanceCommit()) {
			ctx.ui.notify(`All ${deps.commitList.length} commit(s) approved`, "success");
			await deps.stopLoop(ctx);
			return false;
		}
		return true;
	}

	// ── Commit review UI ────────────────────────────

	async function showCommitForReview(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await deps.stopLoop(ctx); return; }

		while (true) {
			deps.awaitFeedback();
			const sha = deps.commitList[deps.currentCommitIdx];
			if (!sha) { await deps.stopLoop(ctx); return; }

			const result = reviewFn(sha, ctx.cwd, originalEditor);

			if (result.approved) {
				if (!await advanceCommit(ctx)) return;
				continue;
			}

			await deps.beginInnerRound(result.feedback, ctx);
			return;
		}
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		if (deps.isIdle) return;
		await deps.stopLoop(ctx);
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
		if (!deps.isIdle) { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return; }
		ctx.cwd = git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// Plannotator: delegate everything (commit selection, diff, annotation)
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			const result0 = deps.initManualSession({
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds,
				loopStartedAt: Date.now(),
				onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
			}, ctx);
			originalEditor = result0.originalEditor;
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await deps.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await deps.beginInnerRound(result.feedback, ctx);
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

		const result = deps.initManualSession({
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds,
			loopStartedAt: Date.now(),
			commitList: [commit], currentCommitIdx: 0,
			pauseTimer: true,
			onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
		}, ctx);
		originalEditor = result.originalEditor;

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
			const result = deps.initManualSession({
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				anchorEntryId: anchor.id,
				loopStartedAt: Date.now(),
				commitList: commits,
				currentCommitIdx: anchor.data.currentCommitIdx ?? 0,
				onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
			}, ctx);
			originalEditor = result.originalEditor;
			ctx.ui.notify(`Resuming manual review — commit ${deps.currentCommitIdx + 1}/${commits.length}`, "info");
			await showCommitForReview(ctx);
			return;
		}

		// Plannotator-backed manual session: verify plannotator is still available
		if (!detectPlannotator(ctx.cwd)) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		const result0 = deps.initManualSession({
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			anchorEntryId: anchor.id,
			loopStartedAt: Date.now(),
			onApproved(innerCtx: any) { void afterInnerLoop(innerCtx); },
		}, ctx);
		originalEditor = result0.originalEditor;
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await deps.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await deps.beginInnerRound(result.feedback, ctx);
		}
	}

	return { start, resume };
}
