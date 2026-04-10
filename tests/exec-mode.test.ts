import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
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
		sendMessage() {},
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

	return { commands, events, ctx, userMessages };
}

test("/loop:exec sends orchestrator prompt (not review prompt)", async () => {
	const h = createHarness();
	const exec = h.commands.get("loop:exec");
	assert.ok(exec, "loop:exec command registered");

	await exec("implement the auth module @docs/plan.md", h.ctx);

	assert.equal(h.userMessages.length, 1, "sends one prompt");
	assert.match(h.userMessages[0], /orchestrator/i, "uses orchestrator prompt");
	assert.doesNotMatch(h.userMessages[0], /code overseer/i, "does not use review prompt");
	assert.match(h.userMessages[0], /implement the auth module/, "includes focus");
});

test("/loop:exec workhorse uses workhorse prompt", async () => {
	const h = createHarness();

	await h.commands.get("loop:exec")!("build the API", h.ctx);

	// Simulate orchestrator response with CHANGES_REQUESTED
	const leafId = h.ctx.sessionManager.getLeafId();
	const entries = h.ctx.sessionManager.getEntries();
	entries.push({
		id: `assistant-1`,
		type: "message",
		message: {
			role: "assistant",
			content: "Implement step 1: create the routes\n\nVERDICT: CHANGES_REQUESTED",
			stopReason: "end_turn",
		},
	});

	const agentEnd = h.events.get("agent_end");
	assert.ok(agentEnd, "agent_end registered");
	agentEnd({}, h.ctx);
	await wait();

	assert.equal(h.userMessages.length, 2, "sends fix prompt after orchestrator verdict");
	assert.match(h.userMessages[1], /Workhorse Task/, "uses workhorse prompt heading");
	assert.match(h.userMessages[1], /create the routes/, "includes orchestrator instructions");
	assert.doesNotMatch(h.userMessages[1], /Overseer Feedback/, "does not use review fix heading");
});

test("/loop:exec workhorse prompt does not contain @path context files", async () => {
	const h = createHarness();

	await h.commands.get("loop:exec")!("build it @docs/plan.md", h.ctx);

	// Orchestrator should have context
	assert.match(h.userMessages[0], /Context files/i, "orchestrator gets context files");

	// Simulate orchestrator CHANGES_REQUESTED
	h.ctx.sessionManager.getEntries().push({
		id: "assistant-ctx",
		type: "message",
		message: {
			role: "assistant",
			content: "Create the User model in models/user.go\n\nVERDICT: CHANGES_REQUESTED",
			stopReason: "end_turn",
		},
	});

	h.events.get("agent_end")!({}, h.ctx);
	await wait();

	// Implementer should NOT get context files
	assert.doesNotMatch(h.userMessages[1], /Context files/i, "implementer does not get context files");
});

test("/loop:exec orchestrator prompt forbids leaking plan to workhorse", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	assert.match(h.userMessages[0], /do not mention future steps/i, "forbids mentioning future steps");
	assert.match(h.userMessages[0], /only describe the current step/i, "restricts output to current step");
});

test("/loop:exec orchestrator prompt requires verification", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	assert.match(h.userMessages[0], /verification checklist/i, "includes verification checklist");
	assert.match(h.userMessages[0], /zero tool calls.*rubber.stamp/i, "warns against zero tool calls");
	assert.match(h.userMessages[0], /run tests/i, "requires running tests");
});

test("/loop:exec workhorse prompt forbids subagents and multi-step", async () => {
	const h = createHarness();

	await h.commands.get("loop:exec")!("build it", h.ctx);

	h.ctx.sessionManager.getEntries().push({
		id: "assistant-sub",
		type: "message",
		message: {
			role: "assistant",
			content: "Do X\n\nVERDICT: CHANGES_REQUESTED",
			stopReason: "end_turn",
		},
	});

	h.events.get("agent_end")!({}, h.ctx);
	await wait();

	assert.match(h.userMessages[1], /only.*single step/i, "restricts to single step");
	assert.match(h.userMessages[1], /not.*subagent/i, "forbids subagents");
	assert.match(h.userMessages[1], /not.*implement ahead/i, "forbids working ahead");
});

test("/loop still uses review prompts", async () => {
	const h = createHarness();
	const loop = h.commands.get("loop");
	assert.ok(loop, "loop command registered");

	await loop("check auth", h.ctx);

	assert.equal(h.userMessages.length, 1);
	assert.match(h.userMessages[0], /code overseer/i, "uses review prompt");
	assert.doesNotMatch(h.userMessages[0], /orchestrator/i, "does not use orchestrator prompt");
});
