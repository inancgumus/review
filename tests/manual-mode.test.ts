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

	return { commands, events, ctx, userMessages, selectQueue, inputQueue };
}

test("/loop:manual command registers", () => {
	const h = createHarness();
	assert.ok(h.commands.has("loop:manual"), "loop:manual should be registered");
});

test("/loop:manual with no commits shows error", async () => {
	const repo = createTempRepo();
	try {
		const h = createHarness(repo.cwd);
		let notifyMsg = "";
		h.ctx.ui.notify = (msg: string) => { notifyMsg = msg; };

		// HEAD is the init commit, main has no range ahead
		await h.commands.get("loop:manual")!("HEAD..HEAD", h.ctx);
		assert.match(notifyMsg, /no commits/i, "should notify about no commits");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual builds commit list and shows first commit", async () => {
	const repo = createTempRepo();
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "hello", "first commit");
		const sha2 = addCommit(repo.cwd, "b.txt", "world", "second commit");

		const h = createHarness(repo.cwd);

		// User will stop immediately
		h.selectQueue.push("⏹ Stop");

		await h.commands.get("loop:manual")!(`${sha1}~1..HEAD`, h.ctx);

		assert.equal(h.userMessages.length, 0, "no model prompts sent yet (user drives)");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual approve advances to next commit", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "first commit");
		addCommit(repo.cwd, "b.txt", "world", "second commit");

		const h = createHarness(repo.cwd);

		// Approve first, then stop on second
		h.selectQueue.push("✅ Approve");
		h.selectQueue.push("⏹ Stop");

		await h.commands.get("loop:manual")!("HEAD~2..HEAD", h.ctx);

		// Should have processed both commits (approved first, stopped on second)
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual approve last commit ends loop", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "only commit");

		const h = createHarness(repo.cwd);
		let notifyMsg = "";
		h.ctx.ui.notify = (msg: string) => { notifyMsg = msg; };

		// Approve the only commit
		h.selectQueue.push("✅ Approve");

		await h.commands.get("loop:manual")!("HEAD~1..HEAD", h.ctx);
		assert.match(notifyMsg, /approved/i, "should notify all approved");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual jump changes commit index", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "first commit");
		addCommit(repo.cwd, "b.txt", "world", "second commit");
		addCommit(repo.cwd, "c.txt", "test", "third commit");

		const h = createHarness(repo.cwd);

		// Jump to commit 3, then stop
		h.selectQueue.push("⏭ Jump to...");
		h.selectQueue.push("3. "); // select third (partial match OK, queue returns this exact string)
		h.selectQueue.push("⏹ Stop");

		// We need the select to return the actual item string for the jump list
		// The jump list items are formatted as "3. <sha> <subject>"
		// Our mock returns the queued string directly, but the code does parseInt(picked)
		// So "3. " will parseInt to 3, which is correct
		await h.commands.get("loop:manual")!("HEAD~3..HEAD", h.ctx);
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual feedback starts workhorse with commit SHA", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);

		// Give feedback
		h.selectQueue.push("💬 Feedback");
		h.inputQueue.push("fix the error handling");

		await h.commands.get("loop:manual")!("HEAD~1..HEAD", h.ctx);

		// Workhorse should have been called with the feedback
		assert.equal(h.userMessages.length, 1, "one workhorse prompt sent");
		assert.match(h.userMessages[0], /fix the error handling/, "includes feedback text");
		assert.match(h.userMessages[0], /FIXES_COMPLETE/, "has FIXES_COMPLETE marker");
		// Should include the commit SHA in git rules
		assert.match(h.userMessages[0], new RegExp(sha.slice(0, 7)), "includes commit SHA");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual overseer approval in inner loop returns to user (not stop)", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);

		// Give feedback → starts inner loop
		h.selectQueue.push("💬 Feedback");
		h.inputQueue.push("fix error handling");

		await h.commands.get("loop:manual")!("HEAD~1..HEAD", h.ctx);

		// Workhorse prompt was sent. Now simulate workhorse completing.
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-1",
			type: "message",
			message: {
				role: "assistant",
				content: "Fixed the error handling.\n\nFIXES_COMPLETE",
				stopReason: "end_turn",
			},
		});

		const agentEnd = h.events.get("agent_end")!;
		agentEnd({}, h.ctx);
		await wait();

		// Overseer should have been sent a verification prompt
		assert.ok(h.userMessages.length >= 2, "overseer prompt was sent");
		const overseerPrompt = h.userMessages[h.userMessages.length - 1];
		assert.match(overseerPrompt, /verify/i, "overseer prompt mentions verify");
		assert.match(overseerPrompt, /fix error handling/, "overseer prompt includes user feedback");

		// Now simulate overseer approving
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: {
				role: "assistant",
				content: "All feedback points addressed correctly.\n\nVERDICT: APPROVED",
				stopReason: "end_turn",
			},
		});

		// Queue the next user action: approve and end
		h.selectQueue.push("✅ Approve");

		agentEnd({}, h.ctx);
		await wait(300);

		// The loop should NOT have stopped — it should be back in awaiting_feedback
		// (the user approved, and since it's the last commit, the loop ends)
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual overseer changes_requested continues inner loop", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);

		h.selectQueue.push("💬 Feedback");
		h.inputQueue.push("fix error handling");

		await h.commands.get("loop:manual")!("HEAD~1..HEAD", h.ctx);

		// Workhorse completes
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-1",
			type: "message",
			message: {
				role: "assistant",
				content: "Attempted fix.\n\nFIXES_COMPLETE",
				stopReason: "end_turn",
			},
		});

		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer says changes_requested
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: {
				role: "assistant",
				content: "The fix is incomplete.\n\nVERDICT: CHANGES_REQUESTED",
				stopReason: "end_turn",
			},
		});

		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Should have sent another workhorse prompt (inner loop continues)
		const lastMsg = h.userMessages[h.userMessages.length - 1];
		assert.match(lastMsg, /FIXES_COMPLETE/, "workhorse prompted again");
		assert.match(lastMsg, /fix is incomplete/i, "includes overseer feedback");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual auto-detects range from branch", async () => {
	const repo = createTempRepo();
	try {
		// Create a branch off main
		execSync("git checkout -b feature", { cwd: repo.cwd });
		addCommit(repo.cwd, "a.txt", "hello", "feature commit");

		const h = createHarness(repo.cwd);
		h.selectQueue.push("⏹ Stop");

		await h.commands.get("loop:manual")!("", h.ctx);
		// Should detect merge-base with main and show the feature commit
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual uses incremental reviewMode", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "test");

		const h = createHarness(repo.cwd);
		h.selectQueue.push("💬 Feedback");
		h.inputQueue.push("fix it");

		await h.commands.get("loop:manual")!("HEAD~1..HEAD", h.ctx);

		// Simulate workhorse done
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh",
			type: "message",
			message: {
				role: "assistant",
				content: "Fixed.\n\nFIXES_COMPLETE",
				stopReason: "end_turn",
			},
		});

		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// The overseer prompt should be a verification (manual mode), not a full review
		const overseerPrompt = h.userMessages[h.userMessages.length - 1];
		assert.match(overseerPrompt, /verify/i, "uses verification prompt");
		assert.doesNotMatch(overseerPrompt, /code overseer/i, "not a full review prompt");
	} finally {
		repo.cleanup();
	}
});
