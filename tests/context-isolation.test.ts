import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolate settings so parallel suites don't race on the global file.
process.env.LOOP_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), "loop-settings-")), "settings.json");

import loopExtension, { loadConfig, saveConfigField } from "../index.ts";
import { V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const prompts: Array<{ content: string; contextLeaf: string | null }> = [];
	const entries: any[] = [];
	const byId = new Map<string, any>();
	let thinking = "low";
	let seq = 0;
	let sessionLeaf: string | null = null;
	let activeLeaf: string | null = null;

	function nextId(prefix: string): string {
		seq++;
		return `${prefix}-${seq}`;
	}

	function addEntry(entry: any): void {
		entries.push(entry);
		byId.set(entry.id, entry);
		sessionLeaf = entry.id;
	}

	function getBranch(leafId: string | null): any[] {
		if (!leafId) return [];
		const path: any[] = [];
		let current = byId.get(leafId);
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	}

	const commandCtx = {
		cwd: process.cwd(),
		hasUI: true,
		model: { provider: "openai", id: "gpt-4.1-mini" },
		modelRegistry: {
			find(provider: string, id: string) {
				return { provider, id };
			},
		},
		waitForIdle: async () => {},
		navigateTree: async (targetId: string) => {
			sessionLeaf = targetId;
			activeLeaf = targetId;
			return { cancelled: false };
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => getBranch(sessionLeaf),
			getLeafId: () => sessionLeaf,
			branch: (id: string) => {
				sessionLeaf = id;
			},
		},
		ui: {
			notify() {},
			setStatus() {},
			select: async () => undefined,
			custom: async () => undefined,
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};

	const eventCtx = {
		cwd: commandCtx.cwd,
		hasUI: commandCtx.hasUI,
		model: commandCtx.model,
		modelRegistry: commandCtx.modelRegistry,
		sessionManager: commandCtx.sessionManager,
		ui: commandCtx.ui,
	};

	const pi = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			events.set(name, handler);
		},
		sendMessage() {},
		sendUserMessage(content: string) {
			const text = String(content);
			const userId = nextId("user");
			addEntry({
				id: userId,
				parentId: sessionLeaf,
				type: "message",
				message: { role: "user", content: text },
			});
			prompts.push({ content: text, contextLeaf: activeLeaf });
			activeLeaf = userId;
		},
		appendEntry(customType: string, data: any) {
			const customId = nextId("custom");
			addEntry({
				id: customId,
				parentId: sessionLeaf,
				type: "custom",
				customType,
				data,
			});
			activeLeaf = customId;
		},
		async setModel(model: any) {
			commandCtx.model = model;
			eventCtx.model = model;
			return true;
		},
		setThinkingLevel(level: string) {
			thinking = level;
		},
		getThinkingLevel() {
			return thinking;
		},
		registerMessageRenderer() {},
	};

	loopExtension(pi as any);

	function pushAssistant(text: string): void {
		const assistantId = nextId("assistant");
		addEntry({
			id: assistantId,
			parentId: sessionLeaf,
			type: "message",
			message: { role: "assistant", content: text, stopReason: "end_turn" },
		});
		activeLeaf = assistantId;
	}

	async function start(): Promise<void> {
		const loop = commands.get("loop");
		assert.ok(loop, "loop command registered");
		await loop("check auth", commandCtx);
	}

	async function agentEnd(): Promise<void> {
		const end = events.get("agent_end");
		assert.ok(end, "agent_end handler registered");
		end({}, eventCtx);
		await wait();
	}

	return { prompts, start, pushAssistant, agentEnd };
}

const overseerText = [
	"## Overseer notes",
	"",
	"- add a zero-divisor guard",
	"",
	`${V_CHANGES}`,
].join("\n");

const workhorseText = [
	"## Workhorse summary",
	"",
	"Added the guard and a regression test.",
	"",
	`${V_FIXES_COMPLETE}`,
].join("\n");

test("fresh mode resets workhorse and next overseer to the same base context", async () => {
	// Ensure fresh mode regardless of user's settings.json
	const savedMode = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "fresh");

	const h = createHarness();
	try {
	await h.start();

	assert.equal(h.prompts.length, 1, "round 1 overseer prompt sent");
	const baseContext = h.prompts[0]?.contextLeaf ?? null;

	h.pushAssistant(overseerText);
	await h.agentEnd();

	assert.equal(
		h.prompts.filter(p => p.content.includes("/loop:_step")).length,
		0,
		"no internal slash-command should leak into visible prompts",
	);
	assert.equal(h.prompts.length, 2, "workhorse prompt sent after overseer verdict");
	assert.match(h.prompts[1]?.content ?? "", /Overseer Feedback — Round 1/, "sent the fix prompt");
	assert.equal(
		h.prompts[1]?.contextLeaf ?? null,
		baseContext,
		"workhorse should run from same base context as round 1 overseer",
	);

	h.pushAssistant(workhorseText);
	await h.agentEnd();

	assert.equal(h.prompts.length, 3, "round 2 overseer prompt sent after workhorse");
	assert.match(h.prompts[2]?.content ?? "", /You are a code overseer/, "sent the full fresh review prompt");
	assert.equal(
		h.prompts[2]?.contextLeaf ?? null,
		baseContext,
		"fresh round 2 overseer should also run from same base context",
	);
	} finally {
		saveConfigField("reviewMode", savedMode);
	}
});
