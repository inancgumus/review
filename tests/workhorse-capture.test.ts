import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";

function wait(ms = 200): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
	const logMessages: string[] = [];
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let thinking = "low";
	let leafId = "root";
	let seq = 0;

	const pi = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			events.set(name, handler);
		},
		sendMessage(message: any) {
			if (message.customType === "loop-log") logMessages.push(String(message.content));
		},
		sendUserMessage(content: string) {
			userMessages.push(String(content));
		},
		appendEntry(_customType: string, _data: any) {
			seq++;
			leafId = `custom-${seq}`;
			entries.push({ id: leafId, type: "custom", customType: _customType, data: _data });
		},
		async setModel(model: any) {
			ctx.model = model;
			return true;
		},
		setThinkingLevel(level: string) { thinking = level; },
		getThinkingLevel() { return thinking; },
		registerMessageRenderer() {},
	};

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		model: { provider: "openai", id: "gpt-4.1-mini" },
		modelRegistry: { find(provider: string, id: string) { return { provider, id }; } },
		waitForIdle: async () => {},
		navigateTree: async (id: string) => { leafId = id; return { cancelled: false }; },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => leafId,
		},
		ui: {
			notify() {},
			setStatus() {},
			select: async () => undefined,
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	loopExtension(pi as any);

	function pushAssistant(text: string): void {
		seq++;
		const id = `assistant-${seq}`;
		entries.push({
			id,
			type: "message",
			message: { role: "assistant", content: text, stopReason: "end_turn" },
		});
		leafId = id;
	}

	async function start(args = "check auth"): Promise<void> {
		const loop = commands.get("loop");
		assert.ok(loop);
		await loop(args, ctx);
	}

	async function fireAgentEnd(): Promise<void> {
		const handler = events.get("agent_end");
		assert.ok(handler);
		handler({}, ctx);
		await wait();
	}

	return { commands, events, ctx, userMessages, logMessages, pushAssistant, start, fireAgentEnd };
}

test("workhorse output is captured using text from agent_end, not re-fetched", async () => {
	const h = createHarness();
	await h.start();

	// Overseer says CHANGES_REQUESTED
	h.pushAssistant("Issue found\n\nVERDICT: CHANGES_REQUESTED");
	await h.fireAgentEnd();

	// Fixer responds with FIXES_COMPLETE
	h.pushAssistant("Fixed the issue and added tests.\n\nFIXES_COMPLETE");

	// Fire agent_end synchronously — this captures text immediately.
	// Then mock getBranch before the 100ms deferred callback fires.
	const handler = h.events.get("agent_end");
	assert.ok(handler);
	handler({}, h.ctx);

	const originalGetBranch = h.ctx.sessionManager.getBranch;
	h.ctx.sessionManager.getBranch = () => [];
	await wait();
	h.ctx.sessionManager.getBranch = originalGetBranch;

	// The fixer summary should still be captured from the text at agent_end time
	const workhorseLogs = h.logMessages.filter(m => m.includes("Workhorse done"));
	assert.ok(workhorseLogs.length > 0, "workhorse output was captured despite branch change");
	assert.ok(workhorseLogs[0].includes("Fixed the issue"), "workhorse summary contains the actual text");
});

test("workhorse with empty last assistant text still triggers re-prompt", async () => {
	const h = createHarness();
	await h.start();

	// Overseer says CHANGES_REQUESTED
	h.pushAssistant("Issue found\n\nVERDICT: CHANGES_REQUESTED");
	await h.fireAgentEnd();

	// Fixer responds with only tool calls, no text content
	// Simulate by pushing an assistant message with empty text
	h.pushAssistant("");
	await h.fireAgentEnd();

	// Should re-prompt instead of silently dropping
	const rePrompts = h.userMessages.filter(m => m.includes("Continue") && m.includes("FIXES_COMPLETE"));
	assert.ok(rePrompts.length > 0, "re-prompts fixer when text is empty");
});
