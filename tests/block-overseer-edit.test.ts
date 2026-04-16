import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
import { V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";

function wait(ms = 200): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => any>();
	const userMessages: string[] = [];
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let thinking = "low";
	let leafId = "root";
	let seq = 0;

	const pi = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => any) {
			events.set(name, handler);
		},
		sendMessage() {},
		sendUserMessage(content: string) { userMessages.push(String(content)); },
		appendEntry(_customType: string, _data: any) {
			seq++;
			leafId = `custom-${seq}`;
			entries.push({ id: leafId, type: "custom", customType: _customType, data: _data });
		},
		async setModel(model: any) { ctx.model = model; return true; },
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
		entries.push({ id, type: "message", message: { role: "assistant", content: text, stopReason: "end_turn" } });
		leafId = id;
	}

	async function callTool(toolName: string): Promise<any> {
		const handler = events.get("tool_call");
		assert.ok(handler, "tool_call handler must be registered");
		return handler({ toolName, toolCallId: `tc-${Date.now()}`, input: {} }, ctx);
	}

	return { commands, events, ctx, userMessages, pushAssistant, callTool };
}

test("edit and write are blocked during reviewing phase", async () => {
	const h = createHarness();
	const loop = h.commands.get("loop");
	assert.ok(loop);

	// Start the loop — enters reviewing phase
	await loop("check auth", h.ctx);

	// Overseer is now reviewing. edit/write should be blocked.
	const editResult = await h.callTool("edit");
	assert.ok(editResult?.block, "edit should be blocked during review");
	assert.ok(editResult.reason?.toLowerCase().includes("blocked"), "reason should mention tools are blocked");

	const writeResult = await h.callTool("write");
	assert.ok(writeResult?.block, "write should be blocked during review");
});

test("read and bash are allowed during reviewing phase", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);

	const readResult = await h.callTool("read");
	assert.ok(!readResult?.block, "read should NOT be blocked during review");

	const bashResult = await h.callTool("bash");
	assert.ok(!bashResult?.block, "bash should NOT be blocked during review");
});

test("edit and write are allowed during fixing phase", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);

	// Simulate overseer finishing with CHANGES_REQUESTED → transitions to fixing
	h.pushAssistant(`Issue found\n\n${V_CHANGES}`);
	const agentEnd = h.events.get("agent_end");
	assert.ok(agentEnd);
	agentEnd({}, h.ctx);
	await wait();

	// Now in fixing phase — edit/write should be allowed
	const editResult = await h.callTool("edit");
	assert.ok(!editResult?.block, "edit should be allowed during fixing");

	const writeResult = await h.callTool("write");
	assert.ok(!writeResult?.block, "write should be allowed during fixing");
});

test("edit and write are allowed when loop is idle", async () => {
	const h = createHarness();

	// Don't start the loop — state.phase is "idle"
	const editResult = await h.callTool("edit");
	assert.ok(!editResult?.block, "edit should be allowed when idle");

	const writeResult = await h.callTool("write");
	assert.ok(!writeResult?.block, "write should be allowed when idle");
});
