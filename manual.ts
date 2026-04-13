/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: commit selection, editor review, plannotator integration.
 * Engine owns: loop state, lifecycle, timing, model switching, navigation, workhorse dispatch.
 *
 * manual.ts does NOT know engine state field names, phases, or reset rules.
 * It talks to engine through semantic methods only.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** What manual.ts needs to start a session. Pure data, no engine internals. */
export interface ManualSessionInit {
	focus: string;
	initialRequest: string;
	contextPaths: string[];
	maxRounds: number;
	commitList?: string[];
	currentCommitIdx?: number;
	anchorEntryId?: string;
	pauseTimer?: boolean;
	onInnerLoopDone: (ctx: any) => void;
}

/**
 * Engine contract for manual mode — 7 semantic methods.
 * No LoopState, no Partial<>, no hooks, no field names.
 */
interface Deps {
	pi: ExtensionAPI;
	startManualSession(opts: ManualSessionInit, ctx: any): boolean;
	stopLoop(ctx: any): Promise<void>;
	beginManualRound(feedback: string, ctx: any): Promise<void>;
	prepareForReview(ctx: any): { sha: string | undefined; savedEditor: string | undefined };
	advanceCommit(): { advanced: boolean; total: number };
	isRunning(): boolean;
}

export function createManualMode(deps: Deps) {
	let reviewFn: (sha: string, cwd: string, editor?: string) => { approved: boolean; feedback: string } = reviewCommitInEditor;
	if (deps.pi.events?.on) {
		deps.pi.events.on("loop:set-review-fn", (fn: any) => { if (typeof fn === "function") reviewFn = fn; });
	}

	// ── Plannotator integration ─────────────────────

	let plannotatorAvailable: boolean | null = null;

	function detectPlannotator(cwd?: string): boolean {
		const cfg = loadConfig(cwd || "");
		if (!cfg.plannotator) { plannotatorAvailable = false; return false; }
		if (plannotatorAvailable !== null) return plannotatorAvailable;
		if (!deps.pi.events?.emit) { plannotatorAvailable = false; return false; }
		let responded = false;
		deps.pi.events.emit("plannotator:request", {
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

	// ── Commit review UI ────────────────────────────

	async function reviewCommitLoop(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await deps.stopLoop(ctx); return; }

		while (true) {
			const { sha, savedEditor } = deps.prepareForReview(ctx);
			if (!sha) { await deps.stopLoop(ctx); return; }

			const result = reviewFn(sha, ctx.cwd, savedEditor);

			if (result.approved) {
				const { advanced, total } = deps.advanceCommit();
				if (!advanced) {
					ctx.ui.notify(`All ${total} commit(s) approved`, "success");
					await deps.stopLoop(ctx);
					return;
				}
				continue;
			}

			await deps.beginManualRound(result.feedback, ctx);
			return;
		}
	}

	// ── Commit resolution ───────────────────────────

	function resolveCommit(sha: string, cwd: string): { commit: string } | null {
		try {
			return { commit: execSync(`git rev-parse ${sha}`, { ...GIT_OPTS, cwd }).trim() };
		} catch {
			return null;
		}
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

		// Plannotator path
		if (detectPlannotator(ctx.cwd) && !trimmedArgs) {
			if (!deps.startManualSession({
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds,
				onInnerLoopDone: (innerCtx) => { if (deps.isRunning()) void deps.stopLoop(innerCtx); },
			}, ctx)) return;
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await deps.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await deps.beginManualRound(result.feedback, ctx);
			}
			return;
		}

		// Editor path
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

		if (!deps.startManualSession({
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds,
			commitList: [commit], currentCommitIdx: 0,
			pauseTimer: true,
			onInnerLoopDone: (innerCtx) => { if (deps.isRunning()) void deps.stopLoop(innerCtx); },
		}, ctx)) return;

		await reviewCommitLoop(ctx);
	}

	async function resume(ctx: any, anchor: { id: string; data: any }): Promise<void> {
		plannotatorAvailable = null;
		ctx.cwd = anchor.data.cwd || git.gitToplevel(ctx.cwd, ctx.sessionManager?.getEntries?.());
		const cfg = loadConfig(ctx.cwd);
		const commits: string[] = Array.isArray(anchor.data.commitList) ? anchor.data.commitList : [];

		// Commit-backed resume
		if (commits.length > 0) {
			for (const sha of commits) {
				try {
					execSync(`git cat-file -t ${sha}`, { ...GIT_OPTS, cwd: ctx.cwd });
				} catch {
					ctx.ui.notify(`Commit ${sha.slice(0, 7)} no longer exists — cannot resume`, "error");
					return;
				}
			}
			const idx = anchor.data.currentCommitIdx ?? 0;
			if (!deps.startManualSession({
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				anchorEntryId: anchor.id,
				commitList: commits,
				currentCommitIdx: idx,
				onInnerLoopDone: (innerCtx) => { if (deps.isRunning()) void deps.stopLoop(innerCtx); },
			}, ctx)) return;
			ctx.ui.notify(`Resuming manual review — commit ${idx + 1}/${commits.length}`, "info");
			await reviewCommitLoop(ctx);
			return;
		}

		// Plannotator-backed resume
		if (!detectPlannotator(ctx.cwd)) {
			ctx.ui.notify("Plannotator is no longer available — cannot resume", "error");
			return;
		}
		if (!deps.startManualSession({
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			anchorEntryId: anchor.id,
			onInnerLoopDone: (innerCtx) => { if (deps.isRunning()) void deps.stopLoop(innerCtx); },
		}, ctx)) return;
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await deps.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await deps.beginManualRound(result.feedback, ctx);
		}
	}

	return { start, resume };
}
