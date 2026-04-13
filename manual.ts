/**
 * Manual review mode — commit-by-commit review driven by the user.
 * Owns: commit selection, editor review, plannotator integration,
 *       session init, inner-round setup, commit advancement, review-status formatting.
 * Engine owns: loop state fields, lifecycle, timing, model switching, navigation, workhorse dispatch.
 *
 * manual.ts talks to engine through generic primitives only.
 * No LoopState, no Partial<>, no engine field names at the module boundary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { reviewCommitInEditor } from "./diff-review.js";
import { execSync } from "node:child_process";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

/** Engine contract — generic loop primitives, no manual-mode knowledge. */
interface Deps {
	pi: ExtensionAPI;
	isIdle(): boolean;
	initState(init: {
		mode: string; focus: string; initialRequest: string;
		contextPaths: string[]; maxRounds: number;
		commits?: string[]; startIdx?: number;
		anchor?: string;
	}, ctx: any): void;
	setModeHooks(hooks: { onApproved?(ctx: any): void; onChangesRequested?(text: string, ctx: any): void; suppressRoundIncrement?: boolean; suppressLogs?: boolean }): void;
	stopLoop(ctx: any): Promise<void>;
	navigateToAnchor(ctx: any): Promise<boolean>;
	startWorkhorse(text: string, ctx: any): Promise<void>;
	updateStatus(ctx: any): void;
	setPhase(phase: string): void;
	setStatusPrefix(prefix: string): void;
	getSavedEditor(): string | undefined;
	pauseTimer(): void;
	resumeTimer(): void;
	modelToStr(model: any): string;
	getCommit(): string | undefined;
	getCommitProgress(): { idx: number; total: number };
	advanceCursor(): void;
	resetRound(feedback: string): void;
	getLoopCommandCtx(): any;
	incrementRound(): void;
}

/** Session config — private to manual.ts, never exported. */
interface SessionConfig {
	focus: string;
	initialRequest: string;
	contextPaths: string[];
	maxRounds: number;
	commits: string[];
	startIdx: number;
	anchor?: string;
	pauseTimer?: boolean;
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

	// ── Session lifecycle (manual.ts owns this) ─────

	function initSession(cfg: SessionConfig, ctx: any): boolean {
		if (!deps.isIdle()) { ctx.ui.notify("Loop already running -- /loop:stop to cancel", "warning"); return false; }
		deps.initState({
			mode: "manual",
			focus: cfg.focus,
			initialRequest: cfg.initialRequest,
			contextPaths: cfg.contextPaths,
			maxRounds: cfg.maxRounds,
			commits: cfg.commits,
			startIdx: cfg.startIdx,
			anchor: cfg.anchor,
		}, ctx);
		if (cfg.pauseTimer) deps.pauseTimer();
		deps.setModeHooks({
			onApproved: (innerCtx: any) => { deps.pauseTimer(); afterInnerLoop(innerCtx); },
			onChangesRequested: () => { deps.incrementRound(); },
			suppressRoundIncrement: true,
			suppressLogs: true,
		});
		return true;
	}

	async function beginRound(feedback: string, ctx: any): Promise<void> {
		const sha = deps.getCommit();
		const text = sha ? `[COMMIT:${sha}]\n${feedback}` : feedback;
		deps.resetRound(feedback);
		deps.resumeTimer();
		if (!await deps.navigateToAnchor(ctx)) return;
		await deps.startWorkhorse(text, ctx);
	}

	function prepareForReview(ctx: any): { sha: string | undefined; savedEditor: string | undefined } {
		deps.setPhase("awaiting_feedback");
		const sha = deps.getCommit();
		if (sha) {
			const { idx, total } = deps.getCommitProgress();
			deps.setStatusPrefix(`Manual: ${sha.slice(0, 7)} (${idx + 1}/${total})`);
			deps.updateStatus(ctx);
		}
		return { sha, savedEditor: deps.getSavedEditor() };
	}

	function advanceCommit(ctx: any): boolean {
		const { idx, total } = deps.getCommitProgress();
		if (idx >= total - 1) {
			ctx.ui.notify(`All ${total} commit(s) approved`, "success");
			return false;
		}
		deps.advanceCursor();
		return true;
	}

	async function afterInnerLoop(ctx: any): Promise<void> {
		if (deps.isIdle()) return;
		const useCtx = deps.getLoopCommandCtx() || ctx;
		await deps.stopLoop(useCtx);
	}

	// ── Commit review UI ────────────────────────────

	async function reviewCommitLoop(ctx: any): Promise<void> {
		if (!recoverGitState(ctx)) { await deps.stopLoop(ctx); return; }

		while (true) {
			const { sha, savedEditor } = prepareForReview(ctx);
			if (!sha) { await deps.stopLoop(ctx); return; }

			const result = reviewFn(sha, ctx.cwd, savedEditor);

			if (result.approved) {
				if (!advanceCommit(ctx)) {
					await deps.stopLoop(ctx);
					return;
				}
				continue;
			}

			await beginRound(result.feedback, ctx);
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
			if (!initSession({
				focus: "manual review", initialRequest: "manual review",
				contextPaths: [], maxRounds: cfg.maxRounds,
				commits: [], startIdx: 0,
			}, ctx)) return;
			ctx.ui.notify("Opening plannotator...", "info");
			const result = await openPlannotator(ctx);
			if (!result || result.approved) {
				ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
				await deps.stopLoop(ctx);
				return;
			}
			if (result.feedback) {
				await beginRound(result.feedback, ctx);
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

		if (!initSession({
			focus: `manual review: ${commit.slice(0, 7)}`,
			initialRequest: `manual review: ${commit.slice(0, 7)}`,
			contextPaths: [], maxRounds: cfg.maxRounds,
			commits: [commit], startIdx: 0,
			pauseTimer: true,
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
			if (!initSession({
				focus: anchor.data.focus ?? `manual review: ${commits.length} commit(s)`,
				initialRequest: anchor.data.initialRequest ?? `manual review: ${commits.length} commit(s)`,
				contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
				maxRounds: cfg.maxRounds,
				anchor: anchor.id,
				commits, startIdx: idx,
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
		if (!initSession({
			focus: anchor.data.focus ?? "manual review",
			initialRequest: anchor.data.initialRequest ?? "manual review",
			contextPaths: Array.isArray(anchor.data.contextPaths) ? anchor.data.contextPaths : [],
			maxRounds: cfg.maxRounds,
			anchor: anchor.id,
			commits: [], startIdx: 0,
		}, ctx)) return;
		ctx.ui.notify("Resuming manual review...", "info");
		const result = await openPlannotator(ctx);
		if (!result || result.approved) {
			ctx.ui.notify(result?.approved ? "Approved" : "Dismissed", "info");
			await deps.stopLoop(ctx);
			return;
		}
		if (result.feedback) {
			await beginRound(result.feedback, ctx);
		}
	}

	return { start, resume };
}
