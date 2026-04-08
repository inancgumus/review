import assert from "node:assert/strict";
import test from "node:test";
import reviewExtension from "../index.ts";
import { loadPiAgent } from "../tui-runtime.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const sentMessages: any[] = [];
	const userMessages: string[] = [];
	const selectCalls: Array<{ title: string; items: string[] }> = [];
	const customCalls: Array<{ factory: any; options: any }> = [];
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
			sentMessages.push(message);
		},
		sendUserMessage(content: string) {
			userMessages.push(String(content));
		},
		appendEntry(customType: string, data: any) {
			seq++;
			leafId = `custom-${seq}`;
			entries.push({ id: leafId, type: "custom", customType, data });
		},
		async setModel(model: any) {
			ctx.model = model;
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

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		model: { provider: "openai", id: "gpt-4.1-mini" },
		modelRegistry: {
			find(provider: string, id: string) {
				return { provider, id };
			},
		},
		waitForIdle: async () => {},
		navigateTree: async (id: string) => {
			leafId = id;
			return { cancelled: false };
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			branch: (id: string) => {
				leafId = id;
			},
			getLeafId: () => leafId,
		},
		ui: {
			notify() {},
			setStatus() {},
			select: async (title: string, items: string[]) => {
				selectCalls.push({ title, items });
				return undefined;
			},
			custom: async (factory: any, options?: any) => {
				customCalls.push({ factory, options });
				return undefined;
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};

	reviewExtension(pi as any);

	async function startRound(reviewText: string, fixerText: string, initialRequest = "check auth") {
		const review = commands.get("review");
		assert.ok(review, "review command registered");
		await review(initialRequest, ctx);

		leafId = "review-1";
		entries.push({
			id: "review-1",
			type: "message",
			message: { role: "assistant", content: reviewText, stopReason: "end_turn" },
		});
		const agentEnd = events.get("agent_end");
		assert.ok(agentEnd, "agent_end handler registered");
		agentEnd({}, ctx);
		await wait();

		leafId = "fix-1";
		entries.push({
			id: "fix-1",
			type: "message",
			message: { role: "assistant", content: fixerText, stopReason: "end_turn" },
		});
		agentEnd({}, ctx);
		await wait();
	}

	async function stopLoop() {
		const stop = commands.get("review:stop");
		assert.ok(stop, "review:stop registered");
		await stop("", ctx);
	}

	return { commands, ctx, customCalls, selectCalls, sentMessages, userMessages, startRound, stopLoop };
}

const reviewerText = [
	"## Reviewer notes",
	"",
	"- add a zero-divisor guard",
	"",
	"**VERDICT:** CHANGES_REQUESTED",
].join("\n");

const fixerText = [
	"### Fixer summary",
	"",
	"Added the guard and a regression test.",
	"",
	"FIXES_COMPLETE",
].join("\n");

test("live review log includes the user's first review message", async () => {
	const h = createHarness();
	const review = h.commands.get("review");
	assert.ok(review, "review command registered");
	await review("fix the auth flow @cmd/login.go", h.ctx);

	const logLines = h.sentMessages
		.filter(message => message.customType === "review-log")
		.map(message => String(message.content));

	assert.match(logLines.join("\n\n"), /\/review fix the auth flow @cmd\/login\.go/, "logs the initial user request");
	await h.stopLoop();
});

test("/review:log opens a modal overlay viewer", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText);

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "opens a custom viewer instead of a plain select menu");
	assert.equal(h.customCalls[0]?.options?.overlay, true, "viewer uses an overlay modal");
	await h.stopLoop();
});

test("/review:log viewer shows reviewer and fixer content with markdown-rendered detail", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText);

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "custom viewer opened");
	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme,
		{},
		() => {},
	);
	const rendered = component.render(120).join("\n");

	assert.match(rendered, /Reviewer notes/, "reviewer content visible");
	assert.match(rendered, /Fixer summary/, "fixer content visible");
	assert.match(rendered, /add a zero-divisor guard/, "reviewer details preserved");
	assert.match(rendered, /Added the guard and a regression test\./, "fixer details preserved");
	assert.doesNotMatch(rendered, /## Reviewer notes/, "reviewer markdown heading is rendered, not shown raw");
	assert.doesNotMatch(rendered, /### Fixer summary/, "fixer markdown heading is rendered, not shown raw");
	await h.stopLoop();
});

test("/review:log viewer includes the user's first review message", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText, "fix the auth flow @cmd/login.go");

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "custom viewer opened");
	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme,
		{},
		() => {},
	);
	const rendered = component.render(120).join("\n");

	assert.match(rendered, /User request/, "shows a user request section");
	assert.match(rendered, /\/review fix the auth flow @cmd\/login\.go/, "shows the initial review command");
	await h.stopLoop();
});
