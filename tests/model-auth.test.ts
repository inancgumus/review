import assert from "node:assert/strict";
import test from "node:test";
import reviewExtension from "../index.ts";

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

	reviewExtension(pi as any);
	return { commands, ctx, notifications, userMessages };
}

test("review stops cleanly when reviewer model cannot be activated", async () => {
	const h = createHarness(false);
	const review = h.commands.get("review");
	assert.ok(review, "review command registered");

	await review("fix the auth flow", h.ctx);

	assert.equal(h.userMessages.length, 0, "does not send a review prompt when model switch fails");
	assert.ok(
		h.notifications.some(n => n.level === "error" && /api key|model/i.test(n.message)),
		"shows an actionable error notification",
	);
});
