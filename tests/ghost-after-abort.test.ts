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

	function pushAssistant(text: string, stopReason = "end_turn"): void {
		seq++;
		const id = `assistant-${seq}`;
		entries.push({
			id,
			type: "message",
			message: { role: "assistant", content: text, stopReason },
		});
		leafId = id;
	}

	async function start(args = "check auth"): Promise<void> {
		const loop = commands.get("loop");
		assert.ok(loop);
		await loop(args, ctx);
	}

	function fireAgentEnd(): void {
		const handler = events.get("agent_end");
		assert.ok(handler);
		handler({}, ctx);
	}

	return { commands, events, ctx, userMessages, logMessages, pushAssistant, start, fireAgentEnd };
}

test("abort during overseer does not produce ghost logs on next agent_end", async () => {
	const h = createHarness();
	await h.start();

	// Overseer is running (phase = "reviewing").
	// User hits Esc — abort fires, agent_end skips processing.
	h.pushAssistant("partial overseer response", "abort");
	h.fireAgentEnd();
	await wait();

	// Phase should NOT still be "reviewing" after an abort.
	// Clear log to isolate ghost messages.
	h.logMessages.length = 0;
	h.userMessages.length = 0;

	// User asks an unrelated question. Agent responds.
	h.pushAssistant("No, v6 API tests are all there.");
	h.fireAgentEnd();
	await wait();

	// No ghost loop-log messages should appear.
	const ghostLogs = h.logMessages.filter(m =>
		m.includes("APPROVED") ||
		m.includes("CHANGES REQUESTED") ||
		m.includes("Round") ||
		m.includes("Continue")
	);
	assert.equal(ghostLogs.length, 0, `ghost logs appeared after abort: ${JSON.stringify(ghostLogs)}`);

	// No ghost user messages (re-prompts) should be sent.
	const ghostPrompts = h.userMessages.filter(m =>
		m.includes("VERDICT") ||
		m.includes("FIXES_COMPLETE")
	);
	assert.equal(ghostPrompts.length, 0, `ghost re-prompts sent after abort: ${JSON.stringify(ghostPrompts)}`);
});

test("abort during workhorse does not produce ghost logs on next agent_end", async () => {
	const h = createHarness();
	await h.start();

	// Overseer responds with CHANGES_REQUESTED → transitions to workhorse.
	h.pushAssistant("Bug found in auth.go\n\nVERDICT: CHANGES_REQUESTED");
	h.fireAgentEnd();
	await wait();

	// Workhorse is running (phase = "fixing").
	// User hits Esc.
	h.pushAssistant("partial workhorse response", "abort");
	h.fireAgentEnd();
	await wait();

	h.logMessages.length = 0;
	h.userMessages.length = 0;

	// User asks an unrelated question.
	h.pushAssistant("Here's what I found about the API.");
	h.fireAgentEnd();
	await wait();

	const ghostLogs = h.logMessages.filter(m =>
		m.includes("APPROVED") ||
		m.includes("Workhorse done") ||
		m.includes("Round") ||
		m.includes("Continue")
	);
	assert.equal(ghostLogs.length, 0, `ghost logs appeared after abort: ${JSON.stringify(ghostLogs)}`);

	const ghostPrompts = h.userMessages.filter(m =>
		m.includes("VERDICT") ||
		m.includes("FIXES_COMPLETE")
	);
	assert.equal(ghostPrompts.length, 0, `ghost re-prompts sent after abort: ${JSON.stringify(ghostPrompts)}`);
});
