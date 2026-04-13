/**
 * Loop engine — state machine, transitions, timing, model switching.
 * All runtime logic lives here. index.ts is just a thin command router.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { LoopMode, LoopState, ModeHooks } from "./types.js";

type Verdict = "approved" | "changes_requested" | null;
import { newState } from "./types.js";
import { loadConfig } from "./config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promptSets, snapshotContextHashes, changedContextPaths as findChangedContextPaths } from "./prompts.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "./verdicts.js";
import { git } from "./git.js";
import { createManualMode } from "./manual.js";
import { execSync } from "node:child_process";

// ── Verdict parsing (absorbed from verdicts.ts) ───────

const APPROVED_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}APPROVED\*{0,2}/i;
const CHANGES_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/i;
const FIXES_COMPLETE_RE = /FIXES_COMPLETE/i;
const VERDICT_STRIP_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}(APPROVED|CHANGES_REQUESTED)\*{0,2}/gi;

function matchVerdict(text: string): Verdict {
	if (APPROVED_RE.test(text)) return "approved";
	if (CHANGES_RE.test(text)) return "changes_requested";
	return null;
}

function hasFixesComplete(text: string): boolean {
	return FIXES_COMPLETE_RE.test(text);
}

function stripVerdict(text: string): string {
	return text
		.replace(VERDICT_STRIP_RE, "")
		.replace(FIXES_COMPLETE_RE, "")
		.trim();
}

// ── Arg parsing (absorbed from context.ts) ─────────────

function expandTilde(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function parseArgs(args: string, cwd: string): { focus: string; contextPaths: string[] } {
	const contextPaths: string[] = [];
	const remaining: string[] = [];
	for (const token of args.split(/\s+/)) {
		if (!token.startsWith("@")) { remaining.push(token); continue; }
		const rawPath = token.slice(1);
		const resolved = path.isAbsolute(rawPath) ? expandTilde(rawPath) : path.join(cwd, rawPath);
		try { fs.statSync(resolved); contextPaths.push(resolved); }
		catch { remaining.push(token); }
	}
	return { focus: remaining.join(" ").trim() || "all recent code changes", contextPaths };
}

// ── Session helpers (absorbed from session.ts) ──────────

/** Strip C0/C1/DEL/zero-width/line separator chars. */
function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
}

function modelToStr(model: any): string {
	if (!model) return "";
	return `${model.provider}/${model.id}`;
}

function findModel(modelStr: string, ctx: any): any | null {
	const idx = modelStr.indexOf("/");
	if (idx === -1) return null;
	return ctx.modelRegistry.find(modelStr.slice(0, idx), modelStr.slice(idx + 1));
}

interface LastAssistant { text: string; stopReason: string | undefined }

function getLastAssistant(ctx: any): LastAssistant {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return { text: extractText(e.message.content), stopReason: e.message.stopReason };
		}
	}
	return { text: "", stopReason: undefined };
}

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

// ── Reconstruct (absorbed from reconstruct.ts) ─────────

interface RecoveredState {
	focus: string;
	round: number;
	phase: "oversee" | "workhorse";
	lastOverseerText: string;
	overseerLeafId: string | null;
}

function reconstructState(ctx: any): RecoveredState | null {
	const entries = ctx.sessionManager.getBranch();
	let lastWorkhorseRound = 0;
	let lastOverseerText = "";
	let lastOverseerRound = 0;
	let focus = "all recent code changes";
	let overseerLeafId: string | null = null;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];

		if (e.type === "custom_message" && (e as any).customType === "workhorse-summary") {
			const text = extractText((e as any).content);
			const m = text.match(/\[Workhorse Round (\d+)\]/);
			if (m && lastWorkhorseRound === 0) lastWorkhorseRound = parseInt(m[1], 10);
			continue;
		}

		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg.role !== "assistant" || lastOverseerRound !== 0) continue;

		const text = extractText(msg.content);
		const verdict = matchVerdict(text);
		if (verdict === "approved") return null;

		if (verdict === "changes_requested") {
			lastOverseerText = text;
			overseerLeafId = e.id;
			lastOverseerRound = findOverseerRound(entries, i);
			focus = findFocus(entries, i) || focus;
			break;
		}
	}

	if (lastWorkhorseRound > 0 && lastWorkhorseRound >= lastOverseerRound) {
		return { focus, round: lastWorkhorseRound + 1, phase: "oversee", lastOverseerText: "", overseerLeafId };
	}
	if (lastOverseerRound > 0 && lastOverseerText) {
		return { focus, round: lastOverseerRound, phase: "workhorse", lastOverseerText, overseerLeafId };
	}
	return null;
}

function findOverseerRound(entries: any[], fromIdx: number): number {
	for (let j = fromIdx - 1; j >= 0; j--) {
		const e = entries[j];
		if (e.type !== "message" || e.message.role !== "user") continue;
		const text = extractText(e.message.content);
		const m = text.match(/Re-review round (\d+)/);
		return m ? parseInt(m[1], 10) : 1;
	}
	return 1;
}

function findFocus(entries: any[], fromIdx: number): string | null {
	for (let j = fromIdx - 1; j >= 0; j--) {
		const e = entries[j];
		if (e.type !== "message" || e.message.role !== "user") continue;
		const text = extractText(e.message.content);
		const m = text.match(/Focus:\s*(.+)/);
		return m ? m[1].trim() : null;
	}
	return null;
}

// ── Editor env blocking ─────────────────────────────────

const EDITOR_BLOCK = `sh -c 'echo "ERROR: Interactive editor blocked during review loop. Use: git commit -m \\"msg\\" or --no-edit for amends. For rebase, prefix with GIT_SEQUENCE_EDITOR=true or GIT_SEQUENCE_EDITOR=\\"sed ...\\"" >&2; exit 1'`;
const EDITOR_VARS: Record<string, string> = { GIT_EDITOR: EDITOR_BLOCK, EDITOR: EDITOR_BLOCK, VISUAL: EDITOR_BLOCK, GIT_SEQUENCE_EDITOR: "true" };
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

// ── Formatting ──────────────────────────────────────────

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

// ── GIT_OPTS ────────────────────────────────────────────

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as const };

// ── Engine ──────────────────────────────────────────────

export interface Engine {
	start(mode: LoopMode, args: string, ctx: any): Promise<void>;
	stop(ctx: any): Promise<void>;
	resume(ctx: any): Promise<void>;
	onAgentEnd(event: any, ctx: any): void;
	state: LoopState;
	startManual(args: string, ctx: any): Promise<void>;
}

export function createEngine(pi: ExtensionAPI): Engine {
	let state: LoopState = newState();
	let loopCommandCtx: any | null = null;
	let statusPrefix = "";
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let pauseStartedAt = 0;
	let modeHooks: ModeHooks = {};

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
			mode: state.mode,
			cwd: ctx.cwd,
			commitList: state.mode === "manual" ? state.commitList : undefined,
			currentCommitIdx: state.mode === "manual" ? state.currentCommitIdx : undefined,
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

	// ── Time tracking ───────────────────────────

	function pauseTimer(): void {
		if (pauseStartedAt === 0) pauseStartedAt = Date.now();
	}

	function resumeTimer(): void {
		if (pauseStartedAt > 0) {
			state.pausedElapsed += Date.now() - pauseStartedAt;
			pauseStartedAt = 0;
		}
	}

	// ── Manual mode ─────────────────────────────

	const manual = createManualMode({
		pi,
		getState: () => state,
		setState: (s) => { state = s; },
		getLoopCommandCtx: () => loopCommandCtx,
		setLoopCommandCtx: (ctx) => { loopCommandCtx = ctx; },
		setStatusPrefix: (s) => { statusPrefix = s; },
		getSavedEditorEnv: () => savedEnv,
		stopLoop, navigateToAnchor, startWorkhorse, updateStatus,
		startStatusTimer, rememberAnchor, blockInteractiveEditors,
		log, pauseTimer, resumeTimer, modelToStr,
		setModeHooks: (hooks: ModeHooks) => { modeHooks = hooks; },
	});

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
		if (!modeHooks.suppressLogs) log(`[Round ${state.round}] Overseer: ${cfg.overseerModel} · mode: ${state.reviewMode} · started: ${formatTime(state.roundStartedAt)}`);
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
			if (state.contextPaths.length > 0) {
				state.contextHashes = snapshotContextHashes(state.contextPaths);
			}
			const taggedSHAs = git.extractTaggedSHAs(overseerText);
			if (taggedSHAs.length > 1) {
				const base = git.findSnapshotBase(ctx.cwd, taggedSHAs);
				if (base) {
					state.patchSnapshot = git.snapshotPatchIds(ctx.cwd, base);
					state.snapshotBase = base;
					state.taggedSubjects = git.resolveSubjects(ctx.cwd, taggedSHAs);
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
		if (!modeHooks.suppressLogs) log(`[Round ${state.round}] Workhorse: ${cfg.workhorseModel}`);
		const prompts = promptSets[state.mode];
		let workhorseInput = overseerText;
		// Manual mode: ensure commit SHA prefix for the workhorse prompt
		if (state.commitList.length > 0) {
			const sha = state.commitList[state.currentCommitIdx];
			if (sha && !workhorseInput.startsWith("[COMMIT:")) {
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
		if (!modeHooks.suppressLogs) log(`🔧 Workhorse done\n${summary}`);

		if (state.contextHashes && state.contextPaths.length > 0) {
			state.changedContextPaths = findChangedContextPaths(state.contextPaths, state.contextHashes);
			if (state.changedContextPaths.length > 0) {
				log(`📄 Changed @paths: ${state.changedContextPaths.length}/${state.contextPaths.length}`);
			}
			state.contextHashes = null;
		}

		const cwd = loopCommandCtx?.cwd || eventCtx?.cwd;
		if (state.patchSnapshot && state.snapshotBase && state.taggedSubjects.length > 0 && cwd) {
			const after = git.snapshotPatchIds(cwd, state.snapshotBase);
			state.unchangedCommits = git.detectUnchanged(state.patchSnapshot, after, state.taggedSubjects);
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
		if (!modeHooks.suppressLogs && state.roundStartedAt) log(`⏱ Round ${state.round}: ${formatDuration(now - state.roundStartedAt)} (${formatTime(state.roundStartedAt)} → ${formatTime(now)})`);

		if (!modeHooks.suppressRoundIncrement) state.round++;
		await continueLoop(eventCtx, { type: "oversee", summaryText: state.reviewMode === "incremental" ? summaryText : undefined });
	}

	async function stopLoop(ctx: any): Promise<void> {
		const wasRunning = state.phase !== "idle";
		const mode = state.mode;

		state.phase = "idle";

		if (mode === "manual" && wasRunning) {
			const gitIssue = git.checkGitState(ctx.cwd);
			if (gitIssue) {
				if (!git.fixGitState(ctx.cwd, gitIssue) && gitIssue.type !== "dirty_tree") {
					ctx.ui.notify(`Git: ${gitIssue.message} -- fix manually`, "warning");
				}
			}
		}

		resumeTimer();
		stopStatusTimer();
		modeHooks = {};
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

	// ── agent_end handling ──────────────────────────────

	function handleOverseerEnd(text: string, ctx: any): void {
		const verdict = matchVerdict(text);

		if (verdict === "approved") {
			recordOverseer(state.round, "approved", text);
			const now = Date.now();
			const rr = state.roundResults.find(r => r.round === state.round);
			if (rr) rr.endedAt = now;

			if (modeHooks.onApproved) {
				deferIf("reviewing", () => modeHooks.onApproved!(ctx));
				return;
			}

			deferIf("reviewing", () => { ctx.ui.notify(`✅ Approved after ${state.round} round(s)`, "success"); stopLoop(ctx); });
			return;
		}
		if (verdict === "changes_requested") {
			recordOverseer(state.round, "changes_requested", text);
			const summary = sanitize(stripVerdict(text));
			if (modeHooks.onChangesRequested) modeHooks.onChangesRequested(text, ctx);
			deferIf("reviewing", () => {
				if (!modeHooks.suppressLogs) log(`❌ CHANGES REQUESTED\n${summary}`);
				if (state.round >= state.maxRounds) { ctx.ui.notify(`Hit ${state.maxRounds} rounds without approval`, "warning"); void stopLoop(ctx); return; }
				void continueLoop(ctx, { type: "workhorse", overseerText: text });
			});
			return;
		}
		deferIf("reviewing", () => pi.sendUserMessage(`Continue. When done, end with ${V_APPROVED} or ${V_CHANGES}`));
	}

	function handleWorkhorseEnd(text: string, ctx: any): void {
		if (hasFixesComplete(text)) {
			deferIf("fixing", () => void onWorkhorseDone(text, ctx));
			return;
		}
		deferIf("fixing", () => pi.sendUserMessage(`Continue addressing the remaining issues. When all fixes are done, end with ${V_FIXES_COMPLETE}`));
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

	// ── Start / Resume ──────────────────────────────────

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

	async function resumeLoop(ctx: any): Promise<void> {
		if (state.phase !== "idle") { ctx.ui.notify("Loop already running", "warning"); return; }
		const anchor = findAnchor(ctx);

		// Manual mode resume — delegate both commit-backed and plannotator sessions
		if (anchor?.data?.mode === "manual") {
			await manual.resume(ctx, anchor);
			return;
		}

		// Restore cwd from anchor (pi can set ctx.cwd to ~ on restart)
		if (anchor?.data?.cwd) ctx.cwd = anchor.data.cwd;

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
	}

	function onAgentEnd(_event: any, ctx: any): void {
		if (state.phase === "idle") return;
		const { text, stopReason } = getLastAssistant(ctx);
		if (stopReason === "abort" || stopReason === "aborted" || stopReason === "cancelled") return;

		if (state.phase === "reviewing") {
			if (!text.trim()) return;
			handleOverseerEnd(text, ctx);
		} else if (state.phase === "fixing") {
			handleWorkhorseEnd(text, ctx);
		}
	}

	return {
		get state() { return state; },
		set state(s: LoopState) { state = s; },
		start: startLoop,
		stop: stopLoop,
		resume: resumeLoop,
		onAgentEnd,
		startManual: manual.start,
	};
}
