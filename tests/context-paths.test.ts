import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import loopExtension from "../index.ts";
import { V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";
import { saveConfigField, loadConfig } from "../config.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness(cwdOverride?: string) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
	const logMessages: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let thinking = "low";
	let leafId = "root";
	let seq = 0;
	const eventHandlers = new Map<string, Function[]>();
	const reviewResults: Array<{ approved: boolean; feedback: string }> = [];
	const selectQueue: (string | undefined)[] = [];
	const inputQueue: (string | undefined)[] = [];

	const pi: any = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			events.set(name, handler);
		},
		events: {
			emit(channel: string, data: unknown) {
				const handlers = eventHandlers.get(channel) || [];
				for (const h of handlers) h(data);
			},
			on(channel: string, handler: Function) {
				if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
				eventHandlers.get(channel)!.push(handler);
				return () => {
					const arr = eventHandlers.get(channel);
					if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
				};
			},
		},
		sendMessage(message: any, _options?: any) {
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

	const ctx: any = {
		cwd: cwdOverride || process.cwd(),
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
			notify(msg: string, level: string) { notifications.push({ message: msg, level }); },
			setStatus() {},
			select: async () => selectQueue.shift(),
			input: async () => inputQueue.shift(),
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	loopExtension(pi as any);

	pi.events.emit("loop:set-review-fn", () => {
		if (reviewResults.length > 0) return reviewResults.shift()!;
		return { approved: true, feedback: "" };
	});

	function pushAssistant(text: string): void {
		seq++;
		const id = `assistant-${seq}`;
		entries.push({
			id, type: "message",
			message: { role: "assistant", content: text, stopReason: "end_turn" },
		});
		leafId = id;
	}

	async function fireAgentEnd(): Promise<void> {
		const handler = events.get("agent_end");
		assert.ok(handler);
		handler({}, ctx);
		await wait();
	}

	async function stopLoop(): Promise<void> {
		const stop = commands.get("loop:stop");
		if (stop) await stop("", ctx);
	}

	return {
		commands, events, ctx, pi, userMessages, logMessages, notifications,
		reviewResults, selectQueue, inputQueue, pushAssistant, fireAgentEnd, stopLoop,
	};
}

// ── Tests ───────────────────────────────────────────────

test("context hashing is consistent for same content", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const file = join(dir, "auth.go");
		writeFileSync(file, "func auth() {}");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${file}`, h.ctx);

		// Overseer says CHANGES_REQUESTED
		h.pushAssistant(`Fix auth\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Do NOT modify the file — content stays the same
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// No changed @paths log
		const hasChangedLog = h.logMessages.some(m => m.includes("📄 Changed @paths"));
		assert.ok(!hasChangedLog, "no changed @paths log when file unchanged");

		// Round 2 prompt should not have updated context section
		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.doesNotMatch(round2, /Updated context files/i, "no context update section");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("context hashing detects changed content", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const file = join(dir, "auth.go");
		writeFileSync(file, "func auth() { old }");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${file}`, h.ctx);

		// Overseer says CHANGES_REQUESTED
		h.pushAssistant(`Fix auth\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Modify the file between snapshot and workhorse completion
		writeFileSync(file, "func auth() { fixed }");

		h.pushAssistant(`Fixed auth.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Should detect the change
		const hasChangedLog = h.logMessages.some(m => m.includes("📄 Changed @paths"));
		assert.ok(hasChangedLog, "logs changed @paths");

		// Round 2 prompt should include updated content
		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.match(round2, /Updated context files/i, "has updated context header");
		assert.match(round2, /func auth\(\) \{ fixed \}/, "includes new file content");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("directory @paths detect changes in child files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const sub = join(dir, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "a.go"), "func a() {}");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${sub}`, h.ctx);

		h.pushAssistant(`Fix it\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Modify a child file inside the directory
		writeFileSync(join(sub, "a.go"), "func a() { fixed }");

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasChangedLog = h.logMessages.some(m => m.includes("📄 Changed @paths"));
		assert.ok(hasChangedLog, "detects change in directory child file");

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.match(round2, /func a\(\) \{ fixed \}/, "includes updated child content");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("directory @paths unchanged when no child files change", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const sub = join(dir, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "a.go"), "func a() {}");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${sub}`, h.ctx);

		h.pushAssistant(`Fix it\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Do NOT modify any child files

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasChangedLog = h.logMessages.some(m => m.includes("📄 Changed @paths"));
		assert.ok(!hasChangedLog, "no changed @paths when directory children unchanged");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing @paths are silently skipped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const realFile = join(dir, "real.go");
		writeFileSync(realFile, "func real() { old }");

		const h = createHarness();
		// Pass a nonexistent @path alongside a real one
		await h.commands.get("loop")!(`check auth @/nonexistent/path.go @${realFile}`, h.ctx);

		// Loop starts without error — only the real file is in contextPaths
		assert.equal(h.userMessages.length, 1, "loop starts normally");

		h.pushAssistant(`Fix it\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Modify the real file
		writeFileSync(realFile, "func real() { fixed }");

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Only the real file detected (1/1 — missing path was silently skipped)
		const changedLog = h.logMessages.find(m => m.includes("📄 Changed @paths"));
		assert.ok(changedLog, "logs changed @paths for real file");
		assert.match(changedLog!, /1\/1/, "shows 1/1 (missing path not counted)");

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists — no crash from missing path");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only modified files are reported as changed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-paths-"));
	const saved = loadConfig(process.cwd()).reviewMode;
	saveConfigField("reviewMode", "incremental");
	try {
		const fileA = join(dir, "a.go");
		const fileB = join(dir, "b.go");
		writeFileSync(fileA, "func a() {}");
		writeFileSync(fileB, "func b() {}");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${fileA} @${fileB}`, h.ctx);

		h.pushAssistant(`Fix it\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Modify only fileA, leave fileB unchanged
		writeFileSync(fileA, "func a() { fixed }");

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Should show 1 out of 2 changed
		const changedLog = h.logMessages.find(m => m.includes("📄 Changed @paths"));
		assert.ok(changedLog, "logs changed @paths");
		assert.match(changedLog!, /1\/2/, "shows 1/2 (only modified file reported)");
		await h.stopLoop();
	} finally {
		saveConfigField("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});
