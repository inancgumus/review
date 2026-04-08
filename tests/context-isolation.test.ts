import assert from "node:assert/strict";
import test from "node:test";
import reviewExtension from "../index.ts";

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

	reviewExtension(pi as any);

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
		const review = commands.get("review");
		assert.ok(review, "review command registered");
		await review("check auth", commandCtx);
	}

	async function agentEnd(): Promise<void> {
		const end = events.get("agent_end");
		assert.ok(end, "agent_end handler registered");
		end({}, eventCtx);
		await wait();
	}

	return { prompts, start, pushAssistant, agentEnd };
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

test("fresh mode resets fixer and next reviewer to the same base context", async () => {
	const h = createHarness();
	await h.start();

	assert.equal(h.prompts.length, 1, "round 1 review prompt sent");
	const baseContext = h.prompts[0]?.contextLeaf ?? null;

	h.pushAssistant(reviewerText);
	await h.agentEnd();

	assert.equal(
		h.prompts.filter(p => p.content.includes("/review:_step")).length,
		0,
		"no internal slash-command should leak into visible prompts",
	);
	assert.equal(h.prompts.length, 2, "fix prompt sent after review verdict");
	assert.match(h.prompts[1]?.content ?? "", /Code Review Feedback — Round 1/, "sent the fix prompt");
	assert.equal(
		h.prompts[1]?.contextLeaf ?? null,
		baseContext,
		"fixer should run from the same clean base context as round 1 reviewer",
	);

	h.pushAssistant(fixerText);
	await h.agentEnd();

	assert.equal(h.prompts.length, 3, "round 2 review prompt sent after fixes");
	assert.match(h.prompts[2]?.content ?? "", /You are a code reviewer/, "sent the full fresh review prompt");
	assert.equal(
		h.prompts[2]?.contextLeaf ?? null,
		baseContext,
		"fresh round 2 reviewer should also run from the same clean base context",
	);
});
