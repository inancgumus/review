import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
import { V_APPROVED } from "../verdicts.ts";

function wait(ms = 200): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
	const events = new Map<string, (event: any, ctx: any) => void>();
	const userMessages: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statusCalls: Array<{ key: string; text: string }> = [];
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
		sendMessage() {},
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
			setStatus(key: string, text: string) { statusCalls.push({ key, text }); },
			select: async () => undefined,
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};

	loopExtension(pi as any);

	function fireAgentEnd(text: string, stopReason = "end_turn") {
		entries.push({
			id: `assistant-${++seq}`,
			type: "message",
			message: { role: "assistant", content: text, stopReason },
		});
		events.get("agent_end")!({}, ctx);
	}

	function lastStatus(): string {
		const last = statusCalls.filter(s => s.key === "loop").at(-1);
		return last?.text ?? "";
	}

	async function stopLoop(): Promise<void> {
		const stop = commands.get("loop:stop");
		if (stop) await stop("", ctx);
	}

	return { commands, events, ctx, pi, userMessages, notifications, statusCalls, fireAgentEnd, lastStatus, stopLoop };
}

// Bug 1: status.stop() was called before status.elapsed() → elapsed always 0 → notification never fires.
test("elapsed notification fires with non-zero duration after approval", async () => {
	const h = createHarness();
	await h.commands.get("loop")!("check code", h.ctx);
	await wait(1200); // Wait >1 second so elapsed > 1000ms

	h.fireAgentEnd(`All good.\n\n${V_APPROVED}`);
	await wait(300);

	const elapsed = h.notifications.find(n => n.message.includes("elapsed") && n.level === "info");
	assert.ok(elapsed, "elapsed notification fires");
	assert.ok(!elapsed!.message.includes("0s"), "elapsed is not 0s");
});

// Bug 3: ghost timers from old extension instance survive hot reload and keep writing to status bar.
test("ghost timer from old extension instance is killed on reload", async () => {
	// First instance — start a loop (timer starts writing to status)
	const h1 = createHarness();
	await h1.commands.get("loop")!("first run", h1.ctx);
	await wait();
	assert.ok(h1.lastStatus().length > 0, "first instance has active status");

	// Simulate hot reload — call loopExtension again (creates a second instance).
	// killGhostTimers() should clear the old intervals.
	const h2 = createHarness();
	await wait(1500); // Wait past a timer tick

	// The old timer should NOT have written new status calls after reload
	const h1StatusAfterReload = h1.statusCalls.length;
	await wait(1500);
	assert.equal(h1.statusCalls.length, h1StatusAfterReload,
		"old timer stopped writing after new instance created");

	await h2.stopLoop(); // cleanup
});

// Bug 2: If start() throws after timer starts but before loopPromise is assigned,
// the timer is orphaned. /loop:stop sees loopPromise=null and can't clean up.
// Mode is stuck forever with an active timer.
test("stop cleans up when start() throws during setup (loopPromise never assigned)", async () => {
	const h = createHarness();

	// Make waitForIdle reject — this happens AFTER startStatusTimer in start()
	let callCount = 0;
	h.ctx.waitForIdle = async () => {
		callCount++;
		if (callCount === 1) throw new Error("session busy");
	};

	// start() should not crash the extension — it should handle the error
	await h.commands.get("loop")!("check code", h.ctx);
	await wait(300);

	// Timer was started before the throw. Status bar might show loop info.
	// Now /loop:stop should still work — clean up the orphaned timer + status.
	await h.stopLoop();
	await wait(300);

	// After stop, status bar must be empty and a new loop must be startable.
	assert.equal(h.lastStatus(), "", "status bar cleared after stop on crashed start");

	// Reset waitForIdle and try starting a new loop
	h.ctx.waitForIdle = async () => {};
	h.notifications.length = 0;
	await h.commands.get("loop")!("second run", h.ctx);
	const blocked = h.notifications.find(n => n.level === "warning" && /already running/i.test(n.message));
	assert.ok(!blocked, "new loop starts after crashed start + stop");

	await h.stopLoop();
});
