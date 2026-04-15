import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
import { V_APPROVED } from "../verdicts.ts";

function createHarness(setModelOk: boolean) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const notifications: Array<{ message: string; level: string }> = [];
	const userMessages: string[] = [];
	let thinking = "low";
	let model = { provider: "openai", id: "gpt-4.1-mini" };
	let leafId: string | null = null;
	const entries: any[] = [];

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		get model() {
			return model;
		},
		set model(v: any) {
			model = v;
		},
		modelRegistry: {
			find(provider: string, id: string) {
				return { provider, id };
			},
		},
		waitForIdle: async () => {},
		navigateTree: async (targetId: string) => {
			leafId = targetId;
			return { cancelled: false };
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => leafId,
			branch(id: string) {
				leafId = id;
			},
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus() {},
			select: async () => undefined,
			input: async () => undefined,
			custom: async () => undefined,
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};

	const pi = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on() {},
		sendMessage() {},
		sendUserMessage(content: string) {
			userMessages.push(String(content));
		},
		appendEntry(customType: string, data: any) {
			leafId = `custom-${entries.length + 1}`;
			entries.push({ id: leafId, type: "custom", customType, data });
		},
		async setModel(nextModel: any) {
			if (setModelOk) model = nextModel;
			return setModelOk;
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
	return { commands, ctx, notifications, userMessages };
}

test("loop stops cleanly when overseer model cannot be activated", async () => {
	const h = createHarness(false);
	const loop = h.commands.get("loop");
	assert.ok(loop, "loop command registered");

	await loop("fix the auth flow", h.ctx);

	assert.equal(h.userMessages.length, 0, "does not send an overseer prompt when model switch fails");
	assert.ok(
		h.notifications.some(n => n.level === "error" && /api key|model/i.test(n.message)),
		"shows an actionable error notification",
	);
});

test("mode warns user when model restore fails after loop", async () => {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const notifications: Array<{ message: string; level: string }> = [];
	const userMessages: string[] = [];
	const events = new Map<string, (event: any, ctx: any) => void>();
	let thinking = "low";
	let model = { provider: "openai", id: "gpt-4.1-mini" };
	let leafId: string | null = null;
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let setModelCallCount = 0;

	const ctx: any = {
		cwd: process.cwd(),
		hasUI: true,
		get model() { return model; },
		set model(v: any) { model = v; },
		modelRegistry: { find(provider: string, id: string) { return { provider, id }; } },
		waitForIdle: async () => {},
		navigateTree: async (id: string) => { leafId = id; return { cancelled: false }; },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => leafId,
			branch(id: string) { leafId = id; },
		},
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus() {},
			select: async () => undefined,
			input: async () => undefined,
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	const pi: any = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			events.set(name, handler);
		},
		sendMessage() {},
		sendUserMessage(content: string) { userMessages.push(String(content)); },
		appendEntry(customType: string, data: any) {
			leafId = `custom-${entries.length + 1}`;
			entries.push({ id: leafId, type: "custom", customType, data });
		},
		async setModel(nextModel: any) {
			setModelCallCount++;
			// First call (switch to overseer) succeeds, restore call fails
			if (setModelCallCount <= 1) { model = nextModel; return true; }
			return false;
		},
		setThinkingLevel(level: string) { thinking = level; },
		getThinkingLevel() { return thinking; },
		registerMessageRenderer() {},
	};

	loopExtension(pi as any);

	// Start fresh review loop (overseer model switch succeeds)
	await commands.get("loop")!("fix auth", ctx);

	// Overseer immediately approves
	entries.push({
		id: "assistant-os",
		type: "message",
		message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
	});
	events.get("agent_end")!({}, ctx);
	await new Promise(resolve => setTimeout(resolve, 300));

	// Loop ended; restoreModel failed because setModel returned false
	assert.ok(
		notifications.some(n => /could not restore/i.test(n.message)),
		`should warn about restore failure, got: ${notifications.map(n => n.message).join("; ")}`,
	);
});
