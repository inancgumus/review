import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
import { V_APPROVED } from "../verdicts.ts";

function wait(ms = 150): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
	let thinking = "low";
	let leafId = "root";
	let seq = 0;

	const pi: any = {
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
			commands.set(name, spec.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => void) {
			events.set(name, handler);
		},
		sendMessage(message: any) {
			if (message.customType === "loop-log") return;
		},
		sendUserMessage(content: string) { userMessages.push(String(content)); },
		appendEntry(_customType: string, _data: any) {
			seq++;
			leafId = `custom-${seq}`;
			entries.push({ id: leafId, type: "custom", customType: _customType, data: _data });
		},
		async setModel(model: any) { ctx.model = model; return true; },
		setThinkingLevel(level: string) { thinking = level; },
		getThinkingLevel() { return thinking; },
		registerMessageRenderer() {},
	};

	const ctx: any = {
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
			notify(msg: string, level: string) { notifications.push({ message: msg, level }); },
			setStatus() {},
			select: async () => undefined,
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	loopExtension(pi as any);

	async function stopLoop(): Promise<void> {
		const stop = commands.get("loop:stop");
		if (stop) await stop("", ctx);
	}

	return { commands, events, ctx, pi, userMessages, notifications, stopLoop };
}

test("starting /loop:exec while /loop is running warns and does nothing", async () => {
	const h = createHarness();

	// Start a review loop — it sends the first overseer prompt
	await h.commands.get("loop")!("check auth", h.ctx);
	assert.equal(h.userMessages.length, 1, "first loop sends prompt");

	// Try starting exec while review is still running
	await h.commands.get("loop:exec")!("build API", h.ctx);

	// Second start should be rejected — no second prompt sent
	assert.equal(h.userMessages.length, 1, "second loop blocked, no additional prompt");

	// Should have a warning notification
	const warn = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(warn, "warning notification about loop already running");

	await h.stopLoop();
});

test("starting /loop while /loop:exec is running warns and does nothing", async () => {
	const h = createHarness();

	await h.commands.get("loop:exec")!("build API", h.ctx);
	assert.equal(h.userMessages.length, 1);

	await h.commands.get("loop")!("check auth", h.ctx);
	assert.equal(h.userMessages.length, 1, "second loop blocked");

	const warn = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(warn);

	await h.stopLoop();
});

test("/loop:stop finds the active loop across modes", async () => {
	const h = createHarness();

	await h.commands.get("loop:exec")!("build API", h.ctx);
	assert.equal(h.userMessages.length, 1);

	await h.stopLoop();

	const stopped = h.notifications.find(n => /stopped/i.test(n.message));
	assert.ok(stopped, "stop notification fired");
});

test("cancelled agent_end clears pending promise so next loop can start", async () => {
	const h = createHarness();

	// Start a review loop
	await h.commands.get("loop")!("check auth", h.ctx);
	assert.equal(h.userMessages.length, 1, "first loop sends prompt");

	// Simulate a cancelled agent_end (user hit Escape mid-turn) WITHOUT calling /loop:stop.
	// The session should reject the pending promise so the mode can clean up.
	const handler = h.events.get("agent_end");
	assert.ok(handler);
	const cancelledEntries = [
		...h.ctx.sessionManager.getEntries(),
		{ id: "cancelled-1", type: "message", message: { role: "assistant", content: "partial...", stopReason: "cancelled" } },
	];
	const cancelCtx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getBranch: () => cancelledEntries } };
	handler({}, cancelCtx);
	await wait(300);

	// Do NOT call /loop:stop. The cancelled agent_end should have cleaned up.
	// Now try starting a new loop.
	h.notifications.length = 0;
	await h.commands.get("loop")!("second run", h.ctx);

	const blocked = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(!blocked, "second loop should not be blocked after cancelled agent_end");
	assert.equal(h.userMessages.length, 2, "second loop sends its own prompt");

	await h.stopLoop();
});

test("/loop:stop during session.send waitForIdle rejects cleanly", async () => {
	const h = createHarness();

	// start() calls waitForIdle once before session.send() calls it again.
	// Block only the second call (inside session.send).
	let idleCallCount = 0;
	let resolveIdle: (() => void) | null = null;
	h.ctx.waitForIdle = () => {
		idleCallCount++;
		if (idleCallCount <= 1) return Promise.resolve();
		return new Promise<void>(resolve => { resolveIdle = resolve; });
	};

	// Start loop — start()'s own waitForIdle resolves instantly,
	// then session.send() blocks on its waitForIdle
	await h.commands.get("loop")!("check auth", h.ctx);
	await wait(50);

	// Stop while session.send()'s waitForIdle is pending
	await h.stopLoop();

	// Resolve the stale waitForIdle — send should NOT emit a message
	if (resolveIdle) (resolveIdle as () => void)();
	await wait(50);

	// No user message should have been sent (stop cleared the pending slot)
	assert.equal(h.userMessages.length, 0, "no prompt sent after stop during wait");

	// Should be able to start a new loop now
	h.ctx.waitForIdle = async () => {};
	h.notifications.length = 0;
	await h.commands.get("loop")!("second run", h.ctx);
	const blocked = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(!blocked, "second loop not blocked");
	assert.equal(h.userMessages.length, 1, "second loop sends its prompt");
	await h.stopLoop();
});
test("/loop:log shows the later run when two different modes ran sequentially", async () => {
	const h = createHarness();

	// Run a fresh review loop — start it, then stop it
	await h.commands.get("loop")!("first review", h.ctx);
	assert.equal(h.userMessages.length, 1);
	await h.stopLoop();

	// Clear notifications to isolate the next check
	h.notifications.length = 0;

	// Now run an exec loop
	await h.commands.get("loop:exec")!("second exec run", h.ctx);
	assert.equal(h.userMessages.length, 2);
	await h.stopLoop();

	// /loop:log should use the exec run (the later one), not the fresh review
	// We can't easily check showLog args, but we can check it doesn't say "No loop rounds"
	// and that the request was "second exec run". Since showLog opens a TUI, we'll check
	// that it doesn't error by verifying no "No loop rounds" notification.
	h.notifications.length = 0;
	await h.commands.get("loop:log")!("", h.ctx);

	// showLog will fail silently in test (no TUI), but it should NOT say "No loop rounds"
	const noRounds = h.notifications.find(n => /No loop rounds/i.test(n.message));
	assert.ok(!noRounds, "should not say no loop rounds — there's data from exec run");
});

test("natural completion with delayed model restore still blocks new loop start", async () => {
	const h = createHarness();

	// Block pi.setModel on the RESTORE call (during cleanup after approval).
	// The first two calls are: (1) start sets overseer model, (2) processLoop may call again.
	// The restore call happens in the finally block.
	const restore = { resolve: null as ((v: boolean) => void) | null };
	let setModelCallCount = 0;
	const origSetModel = h.pi.setModel;
	h.pi.setModel = (model: any) => {
		setModelCallCount++;
		h.ctx.model = model;
		// First call: overseer model in start() — let through
		if (setModelCallCount <= 1) return origSetModel(model);
		// Second+ call: restore in finally — block it
		return new Promise<boolean>(resolve => { restore.resolve = resolve; });
	};

	// Start review loop
	await h.commands.get("loop")!("check auth", h.ctx);
	assert.equal(h.userMessages.length, 1, "first loop sends prompt");

	// Simulate overseer approving → loop ends naturally
	const entries = h.ctx.sessionManager.getEntries();
	entries.push({
		id: "assistant-approve",
		type: "message",
		message: { role: "assistant", content: `Looks good.\n\n${V_APPROVED}`, stopReason: "end_turn" },
	});
	h.events.get("agent_end")!({}, h.ctx);
	await wait(100);

	// Restore is now pending (pi.setModel blocked). Try starting exec.
	h.notifications.length = 0;
	await h.commands.get("loop:exec")!("build API", h.ctx);

	// Should be blocked — the previous loop's cleanup hasn't finished
	const blocked = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(blocked, "exec should be blocked while restore is pending");
	assert.equal(h.userMessages.length, 1, "no second prompt sent");

	// Resolve the restore
	restore.resolve?.(true);
	await wait(200);

	// Now a new loop should work
	h.pi.setModel = origSetModel;
	h.notifications.length = 0;
	await h.commands.get("loop:exec")!("build API", h.ctx);
	const blocked2 = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(!blocked2, "exec should start after restore completes");
	assert.equal(h.userMessages.length, 2, "second loop sends its prompt");
	await h.stopLoop();
});

test("/loop:stop during setModel prevents next prompt from being sent", async () => {
	const h = createHarness();

	// Make pi.setModel block so we can stop while it's pending
	let resolveSetModel: ((v: boolean) => void) | null = null;
	let setModelCallCount = 0;
	h.ctx.model = { provider: "openai", id: "gpt-4.1-mini" };
	const origSetModel = h.pi.setModel;
	h.pi.setModel = (model: any) => {
		setModelCallCount++;
		h.ctx.model = model;
		// Block on the first setModel call (during start)
		if (setModelCallCount === 1) {
			return new Promise<boolean>(resolve => {
				resolveSetModel = resolve;
			});
		}
		return origSetModel(model);
	};

	// Start loop — start()'s setModel blocks
	const startPromise = h.commands.get("loop")!("check auth", h.ctx);
	await wait(50);

	// No prompt sent yet (setModel hasn't resolved)
	assert.equal(h.userMessages.length, 0, "no prompt while setModel pending");

	// Stop while setModel is pending
	await h.stopLoop();
	await wait(50);

	// Resolve the blocked setModel — the mode should NOT continue to send()
	if (resolveSetModel) (resolveSetModel as (v: boolean) => void)(true);
	await wait(200);
	if (startPromise) await startPromise.catch(() => {});

	assert.equal(h.userMessages.length, 0, "no prompt sent after stop during setModel");

	// Verify a new loop can start afterward
	h.pi.setModel = origSetModel;
	h.notifications.length = 0;
	await h.commands.get("loop")!("second run", h.ctx);
	const blocked = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(!blocked, "second loop not blocked");
	assert.equal(h.userMessages.length, 1, "second loop sends its prompt");
	await h.stopLoop();
});
