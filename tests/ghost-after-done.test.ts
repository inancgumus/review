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
	const logMessages: { content: string; options: any }[] = [];
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
		sendMessage(message: any, options?: any) {
			if (message.customType === "loop-log") {
				logMessages.push({ content: String(message.content), options: options ?? {} });
			}
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

test("log() uses followUp delivery so messages render immediately, not on next turn", async () => {
	const h = createHarness();
	await h.start();

	// Every loop-log message should use deliverAs: "followUp" to avoid
	// being queued and rendering on the next user turn as a ghost.
	for (const msg of h.logMessages) {
		assert.equal(
			msg.options.deliverAs, "followUp",
			`loop-log message should use deliverAs:"followUp" but got "${msg.options.deliverAs}": "${msg.content}"`,
		);
	}
});
