import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";
import { tmpdir } from "node:os";
import loopExtension from "../index.ts";

const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "loop-settings-"));
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
process.env.LOOP_SETTINGS_PATH = SETTINGS_PATH;

function readSettings(): any {
	try { return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")); }
	catch { return {}; }
}

function writeSettings(settings: any): void {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function setLoopSetting(key: string, value: unknown): void {
	const settings = readSettings();
	if (!settings.loop) settings.loop = {};
	settings.loop[key] = value;
	writeSettings(settings);
}

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
	const selectCalls: Array<{ prompt: string; items: any }> = [];
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
			select: async (prompt?: string, items?: any) => {
				if (prompt && items) selectCalls.push({ prompt, items });
				return selectQueue.shift();
			},
			input: async () => inputQueue.shift(),
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	// Mock review function — returns from reviewResults queue, default = approve
	let currentReviewFn: (...args: any[]) => any = () => {
		if (reviewResults.length > 0) return reviewResults.shift()!;
		return { approved: true, feedback: "" };
	};

	loopExtension(pi as any, {
		reviewFn: (sha: string, cwd: string, editor?: string) => currentReviewFn(sha, cwd, editor),
	});

	function setReviewFn(fn: (...args: any[]) => any) { currentReviewFn = fn; }

	async function stopLoop(): Promise<void> {
		const stop = commands.get("loop:stop");
		if (stop) await stop("", ctx);
	}

	return { commands, events, ctx, pi, userMessages, selectQueue, selectCalls, inputQueue, reviewResults, setReviewFn, stopLoop };
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
		assert.ok(h.userMessages[0].includes(V_FIXES_COMPLETE), "has FIXES_COMPLETE marker");
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
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
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
			message: { role: "assistant", content: `Attempted fix.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer says changes_requested
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-1",
			type: "message",
			message: { role: "assistant", content: `The fix is incomplete.\n\n${V_CHANGES}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		const lastMsg = h.userMessages[h.userMessages.length - 1];
		assert.ok(lastMsg.includes(V_FIXES_COMPLETE), "workhorse prompted again");
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
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
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
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
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

test("/loop:manual records roundResults so /loop:log has data", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		const notifications: Array<{ message: string; level: string }> = [];
		h.ctx.ui.notify = (msg: string, level: string) => { notifications.push({ message: msg, level }); };

		// One round: workhorse fixes, overseer approves
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse completes
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-rr",
			type: "message",
			message: { role: "assistant", content: `Fixed the error handling.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer approves
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-rr",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(400);

		// Capture the factory passed to ctx.ui.custom by /loop:log
		let capturedFactory: any = null;
		h.ctx.ui.custom = async (factory: any) => { capturedFactory = factory; };
		notifications.length = 0;
		await h.commands.get("loop:log")!("", h.ctx);

		const noRounds = notifications.find(n => /No loop rounds/i.test(n.message));
		assert.ok(!noRounds, "should not say no loop rounds after a manual run");
		assert.ok(capturedFactory, "/loop:log should open the viewer");

		// Render the log viewer and check it contains round data
		const { loadPiAgent } = await import("./test-helpers.ts");
		const { initTheme } = await loadPiAgent();
		initTheme();
		const component = await capturedFactory(
			{ requestRender() {}, terminal: { rows: 40 } },
			h.ctx.ui.theme, {}, () => {},
		);
		const rendered = component.render(120).join("\n");
		assert.match(rendered, /1 round/, "log viewer shows 1 round");
		assert.match(rendered, /Overseer|overseer/i, "log viewer has overseer entry");
		assert.match(rendered, /Workhorse|workhorse/i, "log viewer has workhorse entry");
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

test("/loop:manual multi-file feedback includes all file references", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello\nworld", "fix stuff");
		writeFileSync(join(repo.cwd, "b.txt"), "other");
		execSync("git add b.txt && git commit --amend --no-edit", { cwd: repo.cwd });
		const amendedSha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		const short = amendedSha.slice(0, 7);

		const h = createHarness(repo.cwd);
		h.reviewResults.push({
			approved: false,
			feedback: `${short}:a.txt:1 — fix greeting\n${short}:b.txt:1 — fix other file`,
		});
		await h.commands.get("loop:manual")!(amendedSha, h.ctx);

		assert.equal(h.userMessages.length, 1, "one workhorse prompt sent");
		assert.match(h.userMessages[0], /a\.txt/, "includes first file reference");
		assert.match(h.userMessages[0], /b\.txt/, "includes second file reference");
		assert.match(h.userMessages[0], /fix greeting/, "includes first comment");
		assert.match(h.userMessages[0], /fix other file/, "includes second comment");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual range feedback includes range in workhorse prompt", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "line1\nline2\nline3\nline4\nline5", "fix stuff");
		const short = sha.slice(0, 7);

		const h = createHarness(repo.cwd);
		h.reviewResults.push({
			approved: false,
			feedback: `${short}:a.txt:2-4 — fix this block`,
		});
		await h.commands.get("loop:manual")!(sha, h.ctx);

		assert.equal(h.userMessages.length, 1, "one workhorse prompt sent");
		assert.match(h.userMessages[0], /a\.txt/, "includes file reference");
		assert.match(h.userMessages[0], /fix this block/, "includes range comment");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual inner loop starts at round 1", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix it" });

		let lastStatus = "";
		h.ctx.ui.setStatus = (key: string, text: string) => { if (key === "loop") lastStatus = text || ""; };

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Status should show Round 1, not Round 0
		assert.ok(lastStatus.includes("Round 1"), `status should show Round 1, got: ${lastStatus}`);
		assert.ok(!lastStatus.includes("Round 0"), `status should NOT show Round 0, got: ${lastStatus}`);
	} finally {
		repo.cleanup();
	}
});

// ── Git integration (from git-manual unit tests) ──────────────────

test("/loop:manual explicit non-HEAD SHA resolves correctly", async () => {
	const repo = createTempRepo();
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "first commit");
		addCommit(repo.cwd, "b.txt", "bbb", "second commit");
		addCommit(repo.cwd, "c.txt", "ccc", "third commit");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix this" });

		// Pass the first (non-HEAD) commit SHA
		await h.commands.get("loop:manual")!(sha1, h.ctx);

		assert.equal(h.userMessages.length, 1, "workhorse prompt sent");
		assert.match(h.userMessages[0], new RegExp(sha1.slice(0, 7)), "references the correct non-HEAD SHA");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual feature branch picker shows only branch commits", async () => {
	const repo = createTempRepo();
	try {
		// init commit already on main
		execSync("git checkout -b feature", { cwd: repo.cwd });
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "feature-A");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "feature-B");

		const h = createHarness(repo.cwd);
		// Pre-load picker to select first item
		h.selectQueue.push(`${sha2.slice(0, 7)} feature-B`);

		await h.commands.get("loop:manual")!("", h.ctx);

		// Verify picker was called with exactly 2 items (only feature commits)
		assert.equal(h.selectCalls.length, 1, "picker called once");
		const items = h.selectCalls[0].items as string[];
		assert.equal(items.length, 2, "picker shows exactly 2 feature branch commits");
		// oldest-first (chronological) order
		assert.match(items[0], /feature-A/, "first item is oldest commit");
		assert.match(items[1], /feature-B/, "second item is newest commit");
		// init commit from main should NOT appear
		const all = items.join(" ");
		assert.doesNotMatch(all, /init/, "init commit from main not in picker");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual commit picker shows chronological order", async () => {
	const repo = createTempRepo();
	try {
		execSync("git checkout -b feature", { cwd: repo.cwd });
		const shaA = addCommit(repo.cwd, "a.txt", "aaa", "commit-A");
		const shaB = addCommit(repo.cwd, "b.txt", "bbb", "commit-B");
		const shaC = addCommit(repo.cwd, "c.txt", "ccc", "commit-C");

		const h = createHarness(repo.cwd);
		h.selectQueue.push(`${shaA.slice(0, 7)} commit-A`);

		await h.commands.get("loop:manual")!("", h.ctx);

		assert.equal(h.selectCalls.length, 1, "picker called");
		const items = h.selectCalls[0].items as string[];
		assert.equal(items.length, 3, "3 commits in picker");
		// chronological (oldest first)
		assert.match(items[0], /commit-A/, "oldest first");
		assert.match(items[1], /commit-B/, "middle");
		assert.match(items[2], /commit-C/, "newest last");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual handles dirty working tree gracefully", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "clean", "committed");

		// Make the tree dirty
		writeFileSync(join(repo.cwd, "dirty.txt"), "uncommitted file");

		const h = createHarness(repo.cwd);
		// Default reviewFn: approve → loop ends normally
		const notifyMsgs: string[] = [];
		h.ctx.ui.notify = (msg: string) => { notifyMsgs.push(msg); };

		await h.commands.get("loop:manual")!(sha, h.ctx);

		// dirty_tree is warn-only in recoverGitState → review still happens
		// Default reviewFn approves → loop ends with "approved" or "ended" notification
		const all = notifyMsgs.join(" ");
		assert.ok(all.includes("approved") || all.includes("ended"), "review completes despite dirty tree");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual recovers from in-progress rebase", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "line1", "first");
		const sha = addCommit(repo.cwd, "a.txt", "line2", "second");

		// Put repo in rebase-in-progress state
		try {
			execSync(
				`GIT_SEQUENCE_EDITOR="sed -i.bak '1s/pick/edit/'" git rebase -i HEAD~1`,
				{ cwd: repo.cwd, encoding: "utf-8" },
			);
		} catch {
			// May throw — that's fine, we just need the rebase-in-progress state
		}

		// Verify rebase is in progress
		const gitDir = execSync("git rev-parse --git-dir", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		const absGitDir = gitDir.startsWith("/") ? gitDir : join(repo.cwd, gitDir);
		const rebaseActive = existsSync(join(absGitDir, "rebase-merge")) || existsSync(join(absGitDir, "rebase-apply"));
		assert.ok(rebaseActive, "rebase should be in progress before test");

		const h = createHarness(repo.cwd);
		const notifyMsgs: string[] = [];
		h.ctx.ui.notify = (msg: string) => { notifyMsgs.push(msg); };

		// Re-resolve sha after potential rebase changes
		const headSha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		await h.commands.get("loop:manual")!(headSha, h.ctx);

		// fixGitState should have aborted the rebase, so loop proceeds
		// Default reviewFn approves → loop ends normally
		const all = notifyMsgs.join(" ");
		assert.ok(all.includes("approved") || all.includes("ended"), "loop completes after rebase recovery");

		// Verify rebase was actually aborted
		const stillRebase = existsSync(join(absGitDir, "rebase-merge")) || existsSync(join(absGitDir, "rebase-apply"));
		assert.ok(!stillRebase, "rebase should be aborted after recovery");
	} finally {
		repo.cleanup();
	}
});

// ── SHA remap after amend ──────────────────────────────

test("/loop:manual remaps SHA after workhorse amends commit", async () => {
	const repo = createTempRepo();
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "original", "fix stuff");

		const h = createHarness(repo.cwd);
		const reviewedShas: string[] = [];

		// Override review function to capture SHA args
		h.setReviewFn((sha: string) => {
			reviewedShas.push(sha);
			if (reviewedShas.length === 1) {
				return { approved: false, feedback: "fix error handling" };
			}
			return { approved: true, feedback: "" };
		});

		await h.commands.get("loop:manual")!(sha1, h.ctx);

		// Workhorse prompt sent
		assert.equal(h.userMessages.length, 1, "one workhorse prompt");

		// Simulate workhorse amending the commit
		writeFileSync(join(repo.cwd, "a.txt"), "fixed");
		execSync("git add a.txt && git commit --amend --no-edit", { cwd: repo.cwd });
		const newSha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		assert.notEqual(newSha, sha1, "amend should create new SHA");

		// Fire workhorse agent_end (FIXES_COMPLETE)
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-wh-remap",
			type: "message",
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Fire overseer agent_end (APPROVED)
		h.ctx.sessionManager.getEntries().push({
			id: "assistant-os-remap",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(300);

		// Second reviewFn call should receive the NEW sha, not the old one
		assert.equal(reviewedShas.length, 2, "reviewFn called twice");
		assert.equal(reviewedShas[0], sha1, "first call uses original SHA");
		assert.equal(reviewedShas[1], newSha, "second call uses remapped SHA after amend");
	} finally {
		repo.cleanup();
	}
});

// ── Resume ──────────────────────────────────────────────

test("/loop:resume with plannotator anchor but no plannotator returns promptly", async () => {
	const repo = createTempRepo();
	try {
		const h = createHarness(repo.cwd);
		const notifyMsgs: string[] = [];
		h.ctx.ui.notify = (msg: string) => { notifyMsgs.push(msg); };

		// Simulate a saved plannotator-backed manual anchor (empty commitList)
		h.ctx.sessionManager.getEntries().push({
			id: "anchor-plan",
			type: "custom",
			customType: "loop-anchor",
			data: {
				mode: "manual",
				focus: "manual review",
				initialRequest: "manual review",
				contextPaths: [],
				commitList: [],
				cwd: repo.cwd,
			},
		});

		// No plannotator handler registered — resume should not hang
		const resume = h.commands.get("loop:resume");
		assert.ok(resume);

		// Use a timeout to detect hangs
		const result = await Promise.race([
			resume("", h.ctx),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
		]);

		assert.notEqual(result, "timeout", "resume should not hang when plannotator is unavailable");
		const all = notifyMsgs.join(" ");
		assert.ok(all.length > 0, "should notify user about the issue");
	} finally {
		repo.cleanup();
	}
});

test("/loop:resume with stale plannotator cache does not hang", async () => {
	const repo = createTempRepo();
	setLoopSetting("plannotator", true);
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);
		const notifyMsgs: string[] = [];
		h.ctx.ui.notify = (msg: string) => { notifyMsgs.push(msg); };

		// Register a plannotator that responds to detection and approves immediately
		let plannotatorActive = true;
		h.pi.events.on("plannotator:request", (req: any) => {
			if (!plannotatorActive) return; // simulate plannotator disappearing
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				req.respond({ status: "handled", result: { approved: true } });
			}
		});

		// Start a plannotator session — this caches plannotator as available
		await h.commands.get("loop:manual")!("", h.ctx);

		// Now make plannotator disappear
		plannotatorActive = false;

		// Resume should detect plannotator is gone, not use stale cache
		const result = await Promise.race([
			h.commands.get("loop:resume")!("", h.ctx),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
		]);

		assert.notEqual(result, "timeout", "resume must not hang with stale plannotator cache");
		const all = notifyMsgs.join(" ");
		assert.match(all, /no longer available/i, "should notify plannotator is gone");
	} finally {
		repo.cleanup();
	}
});

// ── Range support ────────────────────────────────────────

test("/loop:manual range a..b reviews all commits in range", async () => {
	const repo = createTempRepo();
	try {
		execSync("git checkout -b feature", { cwd: repo.cwd });
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "first feature");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "second feature");
		const sha3 = addCommit(repo.cwd, "c.txt", "ccc", "third feature");

		const h = createHarness(repo.cwd);
		const reviewedShas: string[] = [];
		h.setReviewFn((sha: string) => {
			reviewedShas.push(sha);
			return { approved: true, feedback: "" };
		});

		// Use range: sha1^..sha3 should include sha1, sha2, sha3
		await h.commands.get("loop:manual")!(`${sha1}^..${sha3}`, h.ctx);

		assert.equal(reviewedShas.length, 3, "should review all 3 commits");
		assert.equal(reviewedShas[0], sha1, "first commit");
		assert.equal(reviewedShas[1], sha2, "second commit");
		assert.equal(reviewedShas[2], sha3, "third commit");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual range with feedback starts workhorse", async () => {
	const repo = createTempRepo();
	try {
		execSync("git checkout -b feature", { cwd: repo.cwd });
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "first feature");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "second feature");

		const h = createHarness(repo.cwd);
		let callCount = 0;
		h.setReviewFn((sha: string) => {
			callCount++;
			if (callCount === 1) return { approved: false, feedback: "fix first commit" };
			return { approved: true, feedback: "" };
		});

		await h.commands.get("loop:manual")!(`${sha1}^..${sha2}`, h.ctx);

		// First commit gets feedback, workhorse prompt sent
		assert.equal(h.userMessages.length, 1, "one workhorse prompt");
		assert.match(h.userMessages[0], /fix first commit/, "includes feedback");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

// ── Duplicate-subject remap ────────────────────────────

test("/loop:manual remap with duplicate subjects picks correct commit", async () => {
	const repo = createTempRepo();
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "fix stuff");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "fix stuff"); // same subject

		const h = createHarness(repo.cwd);
		const reviewedShas: string[] = [];
		h.setReviewFn((sha: string) => {
			reviewedShas.push(sha);
			if (reviewedShas.length === 1) return { approved: false, feedback: "fix error handling" };
			return { approved: true, feedback: "" };
		});

		await h.commands.get("loop:manual")!(sha2, h.ctx);

		// Simulate workhorse amending sha2 (HEAD)
		writeFileSync(join(repo.cwd, "b.txt"), "fixed");
		execSync("git add b.txt && git commit --amend --no-edit", { cwd: repo.cwd });
		const newSha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();

		// Workhorse done
		h.ctx.sessionManager.getEntries().push({
			id: "wh-dup",
			type: "message",
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer approves
		h.ctx.sessionManager.getEntries().push({
			id: "os-dup",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(300);

		// Second reviewFn should get newSha, NOT sha1
		assert.equal(reviewedShas.length, 2, "reviewFn called twice");
		assert.equal(reviewedShas[1], newSha, "remaps to correct commit despite duplicate subject");
	} finally {
		repo.cleanup();
	}
});

test("/loop:manual first commit lost via remap, next commit still reviewed", async () => {
	const repo = createTempRepo();
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "first commit");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "second commit");

		const h = createHarness(repo.cwd);
		const reviewedShas: string[] = [];
		h.setReviewFn((sha: string) => {
			reviewedShas.push(sha);
			if (reviewedShas.length === 1) return { approved: false, feedback: "fix first commit" };
			return { approved: true, feedback: "" };
		});

		await h.commands.get("loop:manual")!(`${sha1}^..${sha2}`, h.ctx);

		assert.equal(reviewedShas.length, 1, "first commit reviewed");
		assert.equal(h.userMessages.length, 1, "workhorse prompt sent");

		// Drop first commit (simulates squash that loses the commit)
		execSync(`git rebase --onto ${sha1}^ ${sha1} HEAD`, { cwd: repo.cwd });

		// Workhorse done
		h.ctx.sessionManager.getEntries().push({
			id: "wh-lost",
			type: "message",
			message: { role: "assistant", content: `Fixed.\n\n${V_FIXES_COMPLETE}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait();

		// Overseer approves
		h.ctx.sessionManager.getEntries().push({
			id: "os-lost",
			type: "message",
			message: { role: "assistant", content: `All good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
		});
		h.events.get("agent_end")!({}, h.ctx);
		await wait(300);

		// Second commit should still be reviewed after first was lost
		assert.equal(reviewedShas.length, 2, "second commit reviewed after first was lost");
	} finally {
		repo.cleanup();
	}
});
