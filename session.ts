/**
 * Session — pi interaction primitives.
 * Model switching, prompt sending, tree navigation, anchor management, editor blocking.
 * Zero knowledge of modes, prompts, or loop logic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sanitize } from "./verdicts.js";

// ── StopError ───────────────────────────────────────────

export class StopError extends Error {
	constructor() {
		super("loop stopped");
		this.name = "StopError";
	}
}

// ── Pure utility functions ──────────────────────────────

/** Strip C0/C1/DEL/zero-width/line separator chars. */
export function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
}

export function modelToStr(model: any): string {
	if (!model) return "";
	return `${model.provider}/${model.id}`;
}

export function findModel(modelStr: string, ctx: any): any | null {
	const idx = modelStr.indexOf("/");
	if (idx === -1) return null;
	return ctx.modelRegistry.find(modelStr.slice(0, idx), modelStr.slice(idx + 1));
}

export function getLastAssistant(ctx: any): { text: string; stopReason: string | undefined } {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return { text: extractText(e.message.content), stopReason: e.message.stopReason };
		}
	}
	return { text: "", stopReason: undefined };
}

export function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

// ── Session interface ───────────────────────────────────

export interface Session {
	setModel(modelStr: string, thinking: string, ctx: any): Promise<boolean>;
	send(prompt: string, ctx?: any): Promise<{ text: string }>;
	navigateToAnchor(ctx: any): Promise<boolean>;
	navigateToEntry(id: string, ctx: any): Promise<boolean>;
	findAnchor(ctx: any): { id: string; data: any } | null;
	rememberAnchor(ctx: any, extras?: Record<string, any>): void;
	getLeafId(ctx: any): string;
	blockEditors(): void;
	restoreEditors(): void;
	log(text: string): void;
	stop(): void;
	getBranch(ctx: any): any[];
}

// ── Editor env blocking ─────────────────────────────────

const EDITOR_BLOCK = `sh -c 'echo "ERROR: Interactive editor blocked during loop. Use: git commit -m \\"msg\\" or --no-edit for amends. For rebase, prefix with GIT_SEQUENCE_EDITOR=true or GIT_SEQUENCE_EDITOR=\\"sed ...\\"" >&2; exit 1'`;
const EDITOR_VARS: Record<string, string> = { GIT_EDITOR: EDITOR_BLOCK, EDITOR: EDITOR_BLOCK, VISUAL: EDITOR_BLOCK, GIT_SEQUENCE_EDITOR: "true" };

// ── createSession ───────────────────────────────────────

export function createSession(pi: ExtensionAPI): Session {
	let anchorEntryId: string | null = null;
	let savedEnv: Record<string, string | undefined> = {};
	let pendingResolve: ((value: { text: string }) => void) | null = null;
	let pendingReject: ((error: Error) => void) | null = null;

	pi.on("agent_end", (_event: any, ctx: any) => {
		if (!pendingResolve) return;
		const { text, stopReason } = getLastAssistant(ctx);
		if (stopReason === "abort" || stopReason === "aborted" || stopReason === "cancelled") {
			const reject = pendingReject;
			pendingResolve = null;
			pendingReject = null;
			if (reject) reject(new StopError());
			return;
		}
		const resolve = pendingResolve;
		pendingResolve = null;
		pendingReject = null;
		resolve({ text });
	});

	async function setModel(modelStr: string, thinking: string, ctx: any): Promise<boolean> {
		const model = findModel(modelStr, ctx);
		if (!model) return false;
		if (!await pi.setModel(model)) return false;
		pi.setThinkingLevel(thinking as any);
		return true;
	}

	function send(prompt: string, ctx?: any): Promise<{ text: string }> {
		if (pendingResolve) throw new Error("send() called while previous send is still pending");
		return new Promise<{ text: string }>((resolve, reject) => {
			pendingResolve = resolve;
			pendingReject = reject;
			const idle = ctx?.waitForIdle?.() ?? Promise.resolve();
			idle.then(() => {
				if (pendingResolve === resolve) {
					pi.sendUserMessage(prompt);
				}
			}, () => {
				if (pendingReject === reject) {
					pendingResolve = null;
					pendingReject = null;
					reject(new StopError());
				}
			});
		});
	}

	function stop(): void {
		if (pendingReject) {
			pendingReject(new StopError());
			pendingResolve = null;
			pendingReject = null;
		}
	}

	function sessionFindAnchor(ctx: any): { id: string; data: any } | null {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === "loop-anchor") {
				anchorEntryId = e.id;
				return { id: e.id, data: e.data };
			}
		}
		return null;
	}

	function rememberAnchor(ctx: any, extras?: Record<string, any>): void {
		pi.appendEntry("loop-anchor", extras ?? {});
		anchorEntryId = ctx.sessionManager.getLeafId();
	}

	async function navigateToEntry(targetId: string, ctx: any): Promise<boolean> {
		if (typeof ctx.navigateTree !== "function") return false;
		const result = await ctx.navigateTree(targetId, { summarize: false });
		return !result?.cancelled;
	}

	async function navigateToAnchor(ctx: any): Promise<boolean> {
		if (!anchorEntryId) anchorEntryId = sessionFindAnchor(ctx)?.id ?? null;
		if (!anchorEntryId) return false;
		return navigateToEntry(anchorEntryId, ctx);
	}

	function getLeafId(ctx: any): string {
		return ctx.sessionManager.getLeafId();
	}

	function getBranch(ctx: any): any[] {
		return ctx.sessionManager.getBranch();
	}

	function blockEditors(): void {
		for (const [k, v] of Object.entries(EDITOR_VARS)) {
			savedEnv[k] = process.env[k];
			process.env[k] = v;
		}
	}

	function restoreEditors(): void {
		for (const k of Object.keys(EDITOR_VARS)) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		savedEnv = {};
	}

	function log(text: string): void {
		pi.sendMessage({ customType: "loop-log", content: sanitize(text), display: true }, { triggerTurn: false, deliverAs: "followUp" });
	}

	return {
		setModel, send, stop,
		findAnchor: sessionFindAnchor, rememberAnchor,
		navigateToEntry, navigateToAnchor,
		getLeafId, getBranch,
		blockEditors, restoreEditors,
		log,
	};
}
