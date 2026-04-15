import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import loopExtension from "../index.ts";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";

// Isolate settings to a temp file so parallel test suites don't race on the global one.
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

function getLoopSetting<T>(key: string, fallback: T): T {
	const settings = readSettings();
	return settings?.loop?.[key] ?? fallback;
}

function setLoopSetting(key: string, value: unknown): void {
	const settings = readSettings();
	if (!settings.loop) settings.loop = {};
	settings.loop[key] = value;
	writeSettings(settings);
}

function wait(ms = 300): Promise<void> {
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
	let reviewResults: Array<{ approved: boolean; feedback: string }> = [];
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

	let currentReviewFn: (...args: any[]) => any = () => {
		if (reviewResults.length > 0) return reviewResults.shift()!;
		return { approved: true, feedback: "" };
	};

	loopExtension(pi as any, {
		reviewFn: (sha: string, cwd: string, editor?: string) => currentReviewFn(sha, cwd, editor),
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

function createTempRepo(): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "loop-prompts-"));
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

// ── Group 1: Exec mode prompts ──────────────────────────

test("exec orchestrator prompt includes V_APPROVED and V_CHANGES markers", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("implement auth", h.ctx);
	assert.ok(h.userMessages[0].includes(V_APPROVED), "includes V_APPROVED");
	assert.ok(h.userMessages[0].includes(V_CHANGES), "includes V_CHANGES");
	await h.stopLoop();
});

test("exec orchestrator prompt forbids file modifications", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("implement auth", h.ctx);
	assert.match(h.userMessages[0], /do not.*(modify|edit|write)/i, "forbids file modifications");
	await h.stopLoop();
});

test("exec orchestrator prompt instructs one step at a time", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("implement auth", h.ctx);
	assert.match(h.userMessages[0], /one.*(step|part)/i, "instructs one step at a time");
	await h.stopLoop();
});

test("exec orchestrator round 2 includes workhorse summaries", async () => {
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "fresh");
	const h = createHarness();
	try {
	await h.commands.get("loop:exec")!("implement auth", h.ctx);

	// Round 1: overseer says CHANGES_REQUESTED
	h.pushAssistant(`<task>\nCreate User struct in models/user.go\n</task>\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	// Round 1: workhorse completes
	h.pushAssistant(`Created User struct in models/user.go\n\n${V_FIXES_COMPLETE}`);
	await h.fireAgentEnd();

	// Round 2 overseer prompt should include workhorse summary
	const round2 = h.userMessages[2];
	assert.ok(round2, "round 2 overseer prompt exists");
	assert.match(round2, /Created User struct/, "includes workhorse summary from round 1");
	await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
	}
});

test("exec workhorse prompt includes V_FIXES_COMPLETE", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	h.pushAssistant(`Do step 1\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	assert.ok(h.userMessages[1].includes(V_FIXES_COMPLETE), "workhorse prompt has V_FIXES_COMPLETE");
	await h.stopLoop();
});

test("exec workhorse prompt strips V_CHANGES from overseer text", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	h.pushAssistant(`Do step 1\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	assert.ok(!h.userMessages[1].includes(V_CHANGES), "workhorse prompt does not contain V_CHANGES");
	await h.stopLoop();
});

test("exec workhorse prompt includes git commit instruction", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	h.pushAssistant(`Do step 1\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	assert.match(h.userMessages[1], /git commit/, "workhorse prompt has git commit instruction");
	await h.stopLoop();
});

test("exec workhorse prompt uses commit not amend", async () => {
	const h = createHarness();
	await h.commands.get("loop:exec")!("build it", h.ctx);

	h.pushAssistant(`Do step 1\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	assert.match(h.userMessages[1], /git commit -m/, "workhorse uses git commit -m (not amend)");
	await h.stopLoop();
});

// ── Group 2: Review mode prompts ────────────────────────

test("review overseer prompt includes V_APPROVED marker", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);
	assert.ok(h.userMessages[0].includes(V_APPROVED), "review prompt includes V_APPROVED");
	await h.stopLoop();
});

test("review workhorse prompt includes Overseer Feedback heading and V_FIXES_COMPLETE", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);

	h.pushAssistant(`Fix the race condition\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	const workhorse = h.userMessages[1];
	assert.match(workhorse, /Overseer Feedback/, "uses Overseer Feedback heading");
	assert.match(workhorse, /Fix the race condition/, "includes overseer text");
	assert.ok(workhorse.includes(V_FIXES_COMPLETE), "has V_FIXES_COMPLETE");
	await h.stopLoop();
});

// ── Group 3: Incremental review (unchanged commits + context) ───

test("incremental review round 2 includes unchanged commits warning", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		// Create 3 commits so extractTaggedSHAs finds multiple
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth module");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "Add request handler");
		const sha3 = addCommit(repo.cwd, "c.txt", "ccc", "Add middleware");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		// Overseer references 3 commit SHAs in backticks
		const overseerText = [
			`Review these commits:`,
			`- \`${sha1.slice(0, 7)}\` Add auth module`,
			`- \`${sha2.slice(0, 7)}\` Add request handler`,
			`- \`${sha3.slice(0, 7)}\` Add middleware`,
			``,
			V_CHANGES,
		].join("\n");
		h.pushAssistant(overseerText);
		await h.fireAgentEnd();

		// Workhorse completes WITHOUT modifying any commits
		h.pushAssistant(`Fixed everything.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Round 2 overseer prompt should warn about unchanged commits
		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 overseer prompt exists");
		assert.match(round2, /unchanged|not modified/i, "warns about unchanged commits");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("incremental review single SHA with actual fix has no unchanged warning", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth module");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant(`Check \`${sha1.slice(0, 7)}\`\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Actually fix the commit so patch-id changes
		writeFileSync(join(repo.cwd, "a.txt"), "aaa fixed");
		execSync(`git add a.txt && git commit --amend --no-edit`, { cwd: repo.cwd });

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.doesNotMatch(round2, /unchanged/i, "no unchanged warning when commit was actually fixed");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("incremental review round 2 includes changed context files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-prompts-"));
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const file = join(dir, "auth.go");
		writeFileSync(file, "func auth() { old }");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${file}`, h.ctx);

		// Overseer says CHANGES_REQUESTED
		h.pushAssistant(`Fix auth\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Modify the @path file (simulating workhorse changing it)
		writeFileSync(file, "func auth() { fixed }");

		// Workhorse completes
		h.pushAssistant(`Fixed auth.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.match(round2, /Updated context files/i, "has context header");
		assert.match(round2, /func auth\(\) \{ fixed \}/, "includes updated file contents");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("incremental review round 2 excludes context when no files changed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-prompts-"));
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const file = join(dir, "auth.go");
		writeFileSync(file, "func auth() {}");

		const h = createHarness();
		await h.commands.get("loop")!(`check auth @${file}`, h.ctx);

		h.pushAssistant(`Fix it\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Do NOT modify the file
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.doesNotMatch(round2, /Context files/i, "no context section when nothing changed");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh review round 2 does NOT include unchanged commits warning", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "fresh");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth module");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "Add handler");
		const sha3 = addCommit(repo.cwd, "c.txt", "ccc", "Add middleware");

		const h = createHarness(repo.cwd);
		// Default reviewMode is "fresh"
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant(`Check \`${sha1.slice(0, 7)}\` \`${sha2.slice(0, 7)}\` \`${sha3.slice(0, 7)}\`\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.doesNotMatch(round2, /unchanged.*commit/i, "fresh mode ignores unchanged commits");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

// ── Group 4: Manual mode prompts ────────────────────────

test("manual overseer prompt does NOT mention orchestrator", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse completes
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Overseer prompt is sent
		const overseerPrompt = h.userMessages[h.userMessages.length - 1];
		assert.doesNotMatch(overseerPrompt, /orchestrator/i, "does not mention orchestrator");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("manual overseer prompt says not to add own issues", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const overseerPrompt = h.userMessages[h.userMessages.length - 1];
		assert.match(overseerPrompt, /not.*add.*own issues/i, "says not to add own issues");
		assert.match(overseerPrompt, /fix error handling/, "overseer round 1 includes user feedback text");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("manual overseer round 2 is shorter re-verify prompt", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse round 1 completes
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Overseer round 1 prompt
		const overseer1 = h.userMessages[h.userMessages.length - 1];
		assert.match(overseer1, /fix error handling/, "round 1 includes user feedback text");

		// Overseer says CHANGES_REQUESTED
		h.pushAssistant(`Still broken.\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Workhorse round 2 completes
		h.pushAssistant(`Fixed again.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Overseer round 2 prompt
		const overseer2 = h.userMessages[h.userMessages.length - 1];

		assert.match(overseer2, /re-verify/i, "round 2 mentions re-verify");
		assert.ok(overseer2.length < overseer1.length, "round 2 is shorter than round 1");
		assert.match(overseer2, new RegExp(sha.slice(0, 7)), "round 2 still includes SHA");
		assert.match(overseer2, /fix error handling/, "round 2 still includes user feedback");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("manual approve with no feedback sends no workhorse prompt", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "only commit");

		const h = createHarness(repo.cwd);
		// Default reviewResults: approved: true, no feedback
		const sha = execSync("git rev-parse HEAD", { cwd: repo.cwd, encoding: "utf-8" }).trim();
		await h.commands.get("loop:manual")!(sha, h.ctx);

		// No workhorse prompt should be sent when review approves immediately
		assert.equal(h.userMessages.length, 0, "no workhorse prompt when approved immediately");
	} finally {
		repo.cleanup();
	}
});

test("manual workhorse prompt includes fixup and amend git rules", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: `${sha.slice(0, 7)}:a.txt:1 — fix error handling` });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		const workhorse = h.userMessages[0];
		assert.match(workhorse, new RegExp(`--fixup=${sha.slice(0, 7)}`), "includes fixup with SHA");
		assert.match(workhorse, /--amend/, "includes amend rule");
		assert.match(workhorse, new RegExp(`git show ${sha.slice(0, 7)}`), "includes git show with SHA");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("manual workhorse prompt strips VERDICT from overseer in inner loop", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: false, feedback: "fix error handling" });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Workhorse round 1 done
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Overseer says CHANGES_REQUESTED
		h.pushAssistant(`Fix incomplete\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// The next workhorse prompt should include the feedback but strip the verdict
		const workhorse2 = h.userMessages[h.userMessages.length - 1];
		assert.match(workhorse2, /Fix incomplete/, "includes overseer feedback");
		assert.ok(!workhorse2.includes(V_CHANGES), "strips V_CHANGES verdict");
		assert.ok(workhorse2.includes(V_FIXES_COMPLETE), "still has V_FIXES_COMPLETE");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

// ── Group 5: rewriteHistory config ──────────────────────

test("review workhorse prompt excludes fixup/amend/rebase by default", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);

	h.pushAssistant(`Fix the bug in auth.go\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	const workhorse = h.userMessages[1];
	assert.doesNotMatch(workhorse, /--fixup/, "no fixup instructions");
	assert.doesNotMatch(workhorse, /--amend/, "no amend instructions");
	assert.doesNotMatch(workhorse, /autosquash/, "no autosquash rebase");
	assert.ok(workhorse.includes(V_FIXES_COMPLETE), "still has V_FIXES_COMPLETE");
	await h.stopLoop();
});

test("review workhorse prompt includes fixup/amend/rebase when rewriteHistory is true", async () => {
	const saved = getLoopSetting("rewriteHistory", false);
	setLoopSetting("rewriteHistory", true);
	try {
		const h = createHarness();
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant(`Fix the bug in auth.go\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		const workhorse = h.userMessages[1];
		assert.match(workhorse, /--fixup/, "includes fixup instructions");
		assert.match(workhorse, /--amend/, "includes amend instructions");
		assert.match(workhorse, /autosquash/, "includes autosquash rebase");
		assert.ok(workhorse.includes(V_FIXES_COMPLETE), "still has V_FIXES_COMPLETE");
		await h.stopLoop();
	} finally {
		setLoopSetting("rewriteHistory", saved);
	}
});

// ── Group 6: Fixup audit (unchanged commits detection) ──

test("unchanged commits detected: logMessages shows warning when workhorse doesn't fix", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth module");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "Add request handler");
		const sha3 = addCommit(repo.cwd, "c.txt", "ccc", "Add middleware");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant([
			`Review these commits:`,
			`- \`${sha1.slice(0, 7)}\` Add auth module`,
			`- \`${sha2.slice(0, 7)}\` Add request handler`,
			`- \`${sha3.slice(0, 7)}\` Add middleware`,
			``,
			V_CHANGES,
		].join("\n"));
		await h.fireAgentEnd();

		// Workhorse does nothing — doesn't fix any commits
		h.pushAssistant(`Fixed everything.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasWarning = h.logMessages.some(m => m.includes("⚠️ Unchanged commits"));
		assert.ok(hasWarning, "logMessages should contain unchanged commits warning");

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 overseer prompt exists");
		assert.match(round2, /unchanged|not modified/i, "round 2 warns about unchanged commits");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("no unchanged warning when workhorse actually fixes commits", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth module");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "Add handler");
		const root = execSync("git rev-list --max-parents=0 HEAD", {
			cwd: repo.cwd, encoding: "utf-8",
		}).trim();

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant([
			`Review commit \`${sha1.slice(0, 7)}\` and \`${sha2.slice(0, 7)}\``,
			``, V_CHANGES,
		].join("\n"));
		await h.fireAgentEnd();

		// Actually fix both commits via fixup + autosquash rebase
		writeFileSync(join(repo.cwd, "a.txt"), "aaa fixed");
		execSync(`git add a.txt && git commit --fixup=${sha1}`, { cwd: repo.cwd });
		writeFileSync(join(repo.cwd, "b.txt"), "bbb fixed");
		execSync(`git add b.txt && git commit --fixup=${sha2}`, { cwd: repo.cwd });
		execSync(`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${root}`, { cwd: repo.cwd });

		h.pushAssistant(`Fixed both commits.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasWarning = h.logMessages.some(m => m.includes("⚠️ Unchanged commits"));
		assert.ok(!hasWarning, "logMessages should NOT contain unchanged commits warning");

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 prompt exists");
		assert.doesNotMatch(round2, /unchanged/i, "round 2 does not warn about unchanged");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("backtick SHAs near commit keyword triggers unchanged detection", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "Add handler");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		// Use "commit" keyword near backtick SHAs
		h.pushAssistant(`Review commit \`${sha1.slice(0, 7)}\` and commit \`${sha2.slice(0, 7)}\`\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Snapshot should have been taken
		const hasSnapshot = h.logMessages.some(m => m.includes("[Snapshot]"));
		assert.ok(hasSnapshot, "snapshot was taken for 2 tagged SHAs");

		// Don't fix commits
		h.pushAssistant(`Done.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasWarning = h.logMessages.some(m => m.includes("⚠️ Unchanged commits"));
		assert.ok(hasWarning, "unchanged warning appears");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("short hex under 7 chars ignored by SHA extraction — no snapshot", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		addCommit(repo.cwd, "a.txt", "aaa", "Add auth");
		addCommit(repo.cwd, "b.txt", "bbb", "Add handler");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		// Overseer uses 4-char hex strings — too short for extraction
		h.pushAssistant(`Check \`a1b2\` and \`c3d4\`\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasSnapshot = h.logMessages.some(m => m.includes("[Snapshot]"));
		assert.ok(!hasSnapshot, "should not snapshot with short hex strings");

		const round2 = h.userMessages[2];
		assert.ok(round2, "round 2 exists");
		assert.doesNotMatch(round2, /unchanged/i, "no unchanged warning");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

test("single tagged SHA triggers unchanged detection when not fixed", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "Add auth");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check auth", h.ctx);

		h.pushAssistant(`Check \`${sha1.slice(0, 7)}\`\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Workhorse claims to fix but doesn't actually modify the commit
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		const hasSnapshot = h.logMessages.some(m => m.includes("[Snapshot]"));
		assert.ok(hasSnapshot, "snapshot was taken for single SHA");

		const hasWarning = h.logMessages.some(m => m.includes("⚠️ Unchanged commits"));
		assert.ok(hasWarning, "warns about unchanged single commit");
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

// ── Group 7: Plannotator path (empty commitList) ────────

test("plannotator path: workhorse prompt does not contain COMMIT:undefined", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);

		// Mock plannotator: respond to detection and return feedback on code-review
		h.pi.events.on("plannotator:request", (req: any) => {
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				req.respond({ status: "handled", result: { approved: false, feedback: "fix the auth bug" } });
			}
		});

		// Start manual mode with no args — triggers plannotator path
		await h.commands.get("loop:manual")!("", h.ctx);

		// Workhorse prompt should have been sent (plannotator returned feedback)
		assert.ok(h.userMessages.length >= 1, "workhorse prompt sent");
		const workhorse1 = h.userMessages[0];
		assert.doesNotMatch(workhorse1, /commit undefined/i, "no 'commit undefined' in workhorse prompt");
		assert.doesNotMatch(workhorse1, /git show undefined/, "no 'git show undefined' in workhorse prompt");
		assert.match(workhorse1, /fix the auth bug/, "includes plannotator feedback");
		assert.match(workhorse1, /referenced in the feedback above/, "uses fallback generic rules");
		assert.ok(workhorse1.includes(V_FIXES_COMPLETE), "has FIXES_COMPLETE");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("plannotator path round 2: workhorse uses fallback when no COMMIT prefix", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);

		h.pi.events.on("plannotator:request", (req: any) => {
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				req.respond({ status: "handled", result: { approved: false, feedback: "fix the auth bug" } });
			}
		});

		await h.commands.get("loop:manual")!("", h.ctx);

		// Round 1: workhorse completes
		h.pushAssistant(`Fixed.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Round 1: overseer says CHANGES_REQUESTED
		h.pushAssistant(`Still broken.\n\n${V_CHANGES}`);
		await h.fireAgentEnd();

		// Round 2 workhorse prompt — commitList is empty, no COMMIT prefix
		const workhorse2 = h.userMessages[h.userMessages.length - 1];
		assert.doesNotMatch(workhorse2, /commit undefined/i, "no 'commit undefined' in round 2");
		assert.doesNotMatch(workhorse2, /git show undefined/, "no 'git show undefined' in round 2");
		assert.match(workhorse2, /referenced in the feedback above/, "uses fallback generic rules");
		assert.ok(workhorse2.includes(V_FIXES_COMPLETE), "has FIXES_COMPLETE");
		await h.stopLoop();
	} finally {
		repo.cleanup();
	}
});

test("plannotator path: /loop:resume does not enter commit-based resume with empty commitList", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);

		// Mock plannotator
		h.pi.events.on("plannotator:request", (req: any) => {
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				// Plannotator approves immediately
				req.respond({ status: "handled", result: { approved: true } });
			}
		});

		// Start plannotator manual mode — approves immediately, loop stops
		await h.commands.get("loop:manual")!("", h.ctx);

		// Now try to resume — should NOT enter commit-based resume
		await h.commands.get("loop:resume")!("", h.ctx);

		// Should not show "commit 1/0" — check notifications
		const allNotifs = h.notifications.map(n => n.message).join(" ");
		assert.doesNotMatch(allNotifs, /commit 1\/0/, "should not show commit 1/0");
		assert.doesNotMatch(allNotifs, /Resuming manual review — commit/, "should not enter commit-based resume path");
	} finally {
		repo.cleanup();
	}
});

test("plannotator path: /loop:resume resumes active plannotator manual session", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);

		// Mock plannotator that gives feedback (enters workhorse phase)
		let plannotatorCalls = 0;
		h.pi.events.on("plannotator:request", (req: any) => {
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				plannotatorCalls++;
				req.respond({ status: "handled", result: { approved: false, feedback: "fix the auth bug" } });
			}
		});

		// Start plannotator manual mode — feedback enters workhorse phase
		await h.commands.get("loop:manual")!("", h.ctx);
		assert.ok(h.userMessages.length >= 1, "workhorse prompt sent");

		// Stop the loop mid-workhorse
		await h.stopLoop();

		// Resume — should NOT say "Nothing to resume"
		h.notifications.length = 0;
		await h.commands.get("loop:resume")!("", h.ctx);

		const allNotifs = h.notifications.map(n => n.message).join(" ");
		assert.doesNotMatch(allNotifs, /Nothing to resume/, "should not say nothing to resume");
		assert.doesNotMatch(allNotifs, /commit 1\/0/, "should not show commit 1/0");
	} finally {
		repo.cleanup();
	}
});

test("commit-backed manual /loop:resume works when ctx.cwd is non-git", async () => {
	const repo = createTempRepo();
	try {
		const sha = addCommit(repo.cwd, "a.txt", "hello", "fix stuff");

		const h = createHarness(repo.cwd);
		h.reviewResults.push({ approved: true, feedback: "" });
		await h.commands.get("loop:manual")!(sha, h.ctx);

		// Simulate pi switching cwd to home (non-git directory)
		h.ctx.cwd = tmpdir();

		h.notifications.length = 0;
		await h.commands.get("loop:resume")!("", h.ctx);

		const allNotifs = h.notifications.map(n => n.message).join(" ");
		// Should NOT fail with "no longer exists" — resume should resolve the repo cwd
		assert.doesNotMatch(allNotifs, /no longer exists/i, "should not claim commit is gone");
		assert.match(allNotifs, /Resuming manual review/i, "should resume successfully");
	} finally {
		repo.cleanup();
	}
});

// ── Group 8: Duplicate-subject unchanged detection ──────

test("two commits with same subject both reported as unchanged", async () => {
	const repo = createTempRepo();
	const saved = getLoopSetting("reviewMode", "fresh");
	setLoopSetting("reviewMode", "incremental");
	try {
		const sha1 = addCommit(repo.cwd, "a.txt", "aaa", "same subject");
		const sha2 = addCommit(repo.cwd, "b.txt", "bbb", "same subject");

		const h = createHarness(repo.cwd);
		await h.commands.get("loop")!("check code", h.ctx);

		h.pushAssistant([
			`Issues in commits \`${sha1.slice(0, 7)}\` and \`${sha2.slice(0, 7)}\``,
			"", V_CHANGES,
		].join("\n"));
		await h.fireAgentEnd();

		// Workhorse does nothing
		h.pushAssistant(`Done.\n\n${V_FIXES_COMPLETE}`);
		await h.fireAgentEnd();

		// Both commits should be reported as unchanged (not just one due to subject dedup)
		const warnings = h.logMessages.filter(m => m.includes("⚠️ Unchanged commits"));
		assert.ok(warnings.length > 0, "should have unchanged warning");
		const warningText = warnings.join(" ");
		const matches = warningText.match(/same subject/g) || [];
		assert.equal(matches.length, 2, `both commits should be listed, got: ${warningText}`);
		await h.stopLoop();
	} finally {
		setLoopSetting("reviewMode", saved);
		repo.cleanup();
	}
});

// ── Group 9: Review/exec resume ─────────────────────────

test("/loop:resume with review anchor resumes review loop", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check auth", h.ctx);

	// Overseer says CHANGES_REQUESTED
	h.pushAssistant(`Found issues.\n\n${V_CHANGES}`);
	await h.fireAgentEnd();

	// Workhorse is running — stop mid-loop
	await h.stopLoop();

	// Resume
	h.notifications.length = 0;
	const msgsBefore = h.userMessages.length;
	await h.commands.get("loop:resume")!("", h.ctx);

	const notifs = h.notifications.map(n => n.message).join(" ");
	assert.doesNotMatch(notifs, /Nothing to resume/i, "should not say nothing to resume");
	assert.ok(h.userMessages.length > msgsBefore, "resume should send a prompt");
	await h.stopLoop();
});

test("plannotator-backed manual /loop:resume resolves repo cwd, not home", async () => {
	const repo = createTempRepo();
	try {
		addCommit(repo.cwd, "a.txt", "hello", "some commit");

		const h = createHarness(repo.cwd);

		let plannotatorCwd = "";
		h.pi.events.on("plannotator:request", (req: any) => {
			if (req.action === "review-status") {
				req.respond({ status: "handled" });
			} else if (req.action === "code-review") {
				plannotatorCwd = req.payload?.cwd || "";
				req.respond({ status: "handled", result: { approved: true } });
			}
		});

		// Start plannotator manual mode — approves, loop stops
		await h.commands.get("loop:manual")!("", h.ctx);

		// Simulate pi switching cwd to home
		h.ctx.cwd = tmpdir();

		h.notifications.length = 0;
		plannotatorCwd = "";
		await h.commands.get("loop:resume")!("", h.ctx);

		// Plannotator should have been called with the repo cwd, not the overridden tmpdir
		assert.ok(plannotatorCwd, "plannotator was called on resume");
		// ctx.cwd was set to tmpdir() before resume — plannotator should NOT get that bare tmpdir
		assert.notEqual(plannotatorCwd, tmpdir(), "plannotator cwd should not be bare tmpdir");
		// It should be the original repo path (stored in anchor)
		assert.equal(realpathSync(plannotatorCwd), realpathSync(repo.cwd), "plannotator cwd should be the repo");
	} finally {
		repo.cleanup();
	}
});
