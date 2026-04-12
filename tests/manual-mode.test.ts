import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import loopExtension from "../index.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createTempRepo(): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "loop-manual-"));
	execSync("git init -b main", { cwd });
	execSync("git config user.email test@test.com && git config user.name Test", { cwd });
	execSync("git commit --allow-empty -m 'init'", { cwd });
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function addCommit(cwd: string, file: string, content: string, msg: string): string {
	writeFileSync(join(cwd, file), content);
	execSync(`git add ${file} && git commit -m '${msg}'`, { cwd });
	return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
}

function createHarness(cwdOverride?: string) {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let thinking = "low";
	let leafId = "root";
	let seq = 0;

	const selectQueue: (string | undefined)[] = [];
	const inputQueue: (string | undefined)[] = [];
	const eventHandlers = new Map<string, Function[]>();
	let reviewResults: Array<{ approved: boolean; feedback: string }> = [];

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
			notify() {},
			setStatus() {},
			select: async () => selectQueue.shift(),
			input: async () => inputQueue.shift(),
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	loopExtension(pi as any);

	// Mock review function — returns from reviewResults queue, default = approve
	pi.events.emit("loop:set-review-fn", () => {
		if (reviewResults.length > 0) return reviewResults.shift()!;
		return { approved: true, feedback: "" };
	});

	return { commands, events, ctx, userMessages, selectQueue, inputQueue, reviewResults };
}

test("/loop:manual command registers", () => {
	const h = createHarness();
	assert.ok(h.commands.has("loop:manual"), "loop:manual should be registered");
});

test("/loop:manual with invalid SHA shows error", async () => {
	const repo = createTempRepo();
	try {
		const h = createHarness(repo.cwd);
		let notifyMsg = "";
		h.ctx.ui.notify = (msg: string) => { notifyMsg = msg; };

		await h.commands.get("loop:manual")!("nonexistent123", h.ctx);
		assert.match(notifyMsg, /could not resolve/i, "should notify about bad SHA");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual approve (no comments) moves to done", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "only commit");

		const h = createHarness(repo.cwd);
		const notifyMsgs: string[] = [];
		h.ctx.ui.notify = (msg: string) => { notifyMsgs.push(msg); };

		// reviewFn returns approve (default)
		const sha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		await h.commands.get("loop:manual")!(sha, h.ctx);
		const all = notifyMsgs.join(" ");
		assert.ok(all.includes("approved") || all.includes("ended"), "should notify done");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual feedback starts workhorse with commit SHA", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: `${sha.slice(0, 7)}:a.txt:1 — fix the error handling` });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		assert.equal(h.userMessages.length, 1, "one workhorse prompt sent");
		assert.match(h.userMessages[0], /fix the error handling/, "includes feedback text");
		assert.match(h.userMessages[0], /FIXES_COMPLETE/, "has FIXES_COMPLETE marker");
		assert.match(h.userMessages[0], new RegExp(sha.slice(0, 7)), "includes commit SHA");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual overseer approval returns to editor review", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		// Cycle 1: feedback
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });
		// Cycle 2 (after inner loop): approve
		h.reviewResults.push({ approved: true, feedback: "" });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse prompt sent
		assert.ok(h.userMessages.length >= 1, "workhorse prompt was sent");

		// Simulate workhorse done → overseer approves
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-1",
			type: "message",
			message: { role: "assistant", content: "Fixed.\n\nFIXES_COMPLETE", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: { role: "assistant", content: "All good.\n\nVERDICT: APPROVED", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(300);

		// After inner loop, reviewFn is called again (cycle 2 = approve) → loop ends
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual overseer changes_requested continues inner loop", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse completes
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-1",
			type: "message",
			message: { role: "assistant", content: "Attempted fix.\n\nFIXES_COMPLETE", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer says changes_requested
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: { role: "assistant", content: "The fix is incomplete.\n\nVERDICT: CHANGES_REQUESTED", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		const lastMsg = h.userMessages[h.userMessages.length - 1];
		assert.match(lastMsg, /FIXES_COMPLETE/, "workhorse prompted again");
		assert.match(lastMsg, /fix is incomplete/i, "includes overseer feedback");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual uses incremental reviewMode", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "test");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix it" });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Simulate workhorse done
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh",
			type: "message",
			message: { role: "assistant", content: "Fixed.\n\nFIXES_COMPLETE", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		const overseerPrompt = h.userMessages[h.userMessages.length - 1];
		assert.match(overseerPrompt, /verify/i, "uses verification prompt");
		assert.doesNotMatch(overseerPrompt, /code overseer/i, "not a full review prompt");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual inner loop completion ends the loop", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Complete the inner loop
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh",
			type: "message",
			message: { role: "assistant", content: "Fixed.\n\nFIXES_COMPLETE", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os",
			type: "message",
			message: { role: "assistant", content: "All good.\n\nVERDICT: APPROVED", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(300);

		// Loop should have ended (single commit, inner loop done)
		// Sending another agent_end should NOT trigger loop behavior
		const msgCountBefore = h.userMessages.length;
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-ghost",
			type: "message",
			message: { role: "assistant", content: "Some response", stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		assert.equal(h.userMessages.length, msgCountBefore, "no ghost loop after stopLoop");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual single commit picker (no args)", async () => {
	const repo = createTempRepo();
	try {
		execSync("git checkout -b feature", { cwd: repo.cwd });
		const sha = addCommit(repo.cwd, "a.txt", "hello", "feature commit");

		const h = createHarness(repo.cwd);
		// Select the commit from picker
		const shortSha = sha.slice(0, 7);
		h.selectQueue.push(`${shortSha} feature commit`);

		await h.commands.get("loop:manual")!("", h.ctx);
		// reviewFn default = approve → loop ends
	} finally {
		repo.cleanup();
	}
});
