/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: commit selection, editor review, plannotator integration.
 * Engine owns: loop lifecycle, timing, status, model switching, state.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** Narrow engine interface — manual never touches lifecycle state directly. */
interface ManualEngine {
	pi: ExtensionAPI;
	/** Read-only commit view for the review UI. */
	getCommitInfo(): { sha: string; index: number; total: number } | null;
	/** Advance to next commit. Returns false if no more commits. */
	advanceCommit(ctx: any): Promise<boolean>;
	/** Transition engine to awaiting_feedback phase. */
	setAwaitingFeedback(): void;
	/** Check if engine is idle (stopped). */
	isIdle(): boolean;
	/** Check if engine is already running. */
	isRunning(): boolean;
	/** Read currentCommitIdx for resume notification. */
	getCurrentCommitIdx(): number;
	initSession(init: SessionInit, ctx: any): { originalEditor: string | undefined };
	stopLoop(ctx: any): Promise<void>;
	beginInnerRound(feedback: string, ctx: any): Promise<void>;
}

interface SessionInit {
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

export function createManualMode(engine: ManualEngine) {
	let originalEditor: string | undefined;
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (engine.pi.events?.on) {
		engine.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Plannotator integration ─────────────────────

	// Local cache, reset on each start().
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

	async function showCommitForReview(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await engine.stopLoop(ctx); return; }

		while (true) {
			engine.setAwaitingFeedback();
			const info = engine.getCommitInfo();
			if (!info) { await engine.stopLoop(ctx); return; }

			const result = reviewFn(info.sha, ctx.cwd, originalEditor);

			if (result.approved) {
				if (!await engine.advanceCommit(ctx)) return;
				continue;
			}

			await engine.beginInnerRound(result.feedback, ctx);
			return;
		}
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		if (engine.isIdle()) return;
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
		if (engine.isRunning()) { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return; }
		plannotatorAvailable = null; // Reset cache each time manual mode starts
		ctx.cwd = git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const trimmedArgs = (args || "").trim();

		// Plannotator: delegate everything (commit selection, diff, annotation)
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			const result0 = engine.initSession({
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
				await engine.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await engine.beginInnerRound(result.feedback, ctx);
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

		const result = engine.initSession({
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
			const result = engine.initSession({
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
			ctx.ui.notify(`Resuming manual review — commit ${engine.getCurrentCommitIdx() + 1}/${commits.length}`, "info");
			await showCommitForReview(ctx);
			return;
		}

		// Plannotator-backed manual session: verify plannotator is still available
		if (!detectPlannotator(ctx.cwd)) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		const result0 = engine.initSession({
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
			await engine.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await engine.beginInnerRound(result.feedback, ctx);
		}
	}

	return { start, resume };
}
