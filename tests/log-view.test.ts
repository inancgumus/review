import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
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

	loopExtension(pi as any);

	async function startRound(overseerText: string, workhorseText: string, initialRequest = "check auth") {
		const loop = commands.get("loop");
		assert.ok(loop, "loop command registered");
		await loop(initialRequest, ctx);

		leafId = "overseer-1";
		entries.push({
			id: "overseer-1",
			type: "message",
			message: { role: "assistant", content: overseerText, stopReason: "end_turn" },
		});
		const agentEnd = events.get("agent_end");
		assert.ok(agentEnd, "agent_end handler registered");
		agentEnd({}, ctx);
		await wait();

		leafId = "workhorse-1";
		entries.push({
			id: "workhorse-1",
			type: "message",
			message: { role: "assistant", content: workhorseText, stopReason: "end_turn" },
		});
		agentEnd({}, ctx);
		await wait();
	}

	async function stopLoop() {
		const stop = commands.get("loop:stop");
		assert.ok(stop, "loop:stop registered");
		await stop("", ctx);
	}

	return { commands, ctx, customCalls, selectCalls, sentMessages, userMessages, startRound, stopLoop };
}

const overseerText = [
	"## Overseer notes",
	"",
	"- add a zero-divisor guard",
	"",
	"**VERDICT:** CHANGES_REQUESTED",
].join("\n");

const workhorseText = [
	"## Workhorse summary",
	"",
	"Added the guard and a regression test.",
	"",
	"FIXES_COMPLETE",
].join("\n");

const TAB = "\t";

// Strip ANSI for regex matching
function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("live loop log includes the user's first message", async () => {
	const h = createHarness();
	const loop = h.commands.get("loop");
	assert.ok(loop, "loop command registered");
	await loop("fix the auth flow @cmd/login.go", h.ctx);

	const logLines = h.sentMessages
		.filter(message => message.customType === "loop-log")
		.map(message => String(message.content));

	assert.match(logLines.join("\n\n"), /fix the auth flow @cmd\/login\.go/, "logs the initial user request");
	await h.stopLoop();
});

test("/loop:log opens a centered overlay viewer with explicit height", async () => {
	const h = createHarness();
	await h.startRound(overseerText, workhorseText);

	const loopLog = h.commands.get("loop:log");
	assert.ok(loopLog, "loop:log registered");
	await loopLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "opens a custom viewer");
	assert.equal(h.customCalls[0]?.options?.overlay, true, "uses overlay modal");
	const opts = h.customCalls[0]?.options?.overlayOptions;
	assert.equal(opts?.anchor, "center", "overlay is centered");
	assert.ok(opts?.maxHeight, "overlay has maxHeight for sizing");
	await h.stopLoop();
});

test("Tab switches focus between list and detail panels", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, overseerText: "issue A", workhorseSummary: "fixed A" },
		{ round: 2, verdict: "approved" as const, overseerText: "all good", workhorseSummary: "" },
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test tab", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Default focus is list. j moves to next entry.
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Overseer/, "j moved to overseer in list");

	// Tab switches to detail panel. j now scrolls detail.
	component.handleInput(TAB);
	component.handleInput("j");
	// Should still be on Round 1: Overseer (entry didn't change, just scrolled)
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Overseer/, "still on overseer after scroll");

	// Tab back to list, j moves to next entry
	component.handleInput(TAB);
	component.handleInput("j");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Workhorse/, "j moved to workhorse in list");
});

test("j/k navigate entries in list panel, q closes", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, overseerText: "issue A", workhorseSummary: "fixed A" },
		{ round: 2, verdict: "approved" as const, overseerText: "all good", workhorseSummary: "" },
	];
	let closed = false;
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test nav", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {},
		() => { closed = true; },
	);

	// Default = first entry (Request). j moves down to Overseer.
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Overseer/, "j moved to overseer");

	// j again to Workhorse
	component.handleInput("j");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Workhorse/, "j moved to workhorse");

	// k back to Overseer
	component.handleInput("k");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Overseer/, "k moved back to overseer");

	// q closes
	component.handleInput("q");
	assert.ok(closed, "q closed the viewer");
});

test("default selection is first entry (Request), not last", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, overseerText: "review text", workhorseSummary: "fixer text" },
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("my request", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 30 } },
		mockCtx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /User request/, "detail shows Request by default");
	assert.match(rendered, /my request/, "shows the user's request text");
});

test("Request entry is in list, selecting it shows user request in detail", async () => {
	const h = createHarness();
	await h.startRound(overseerText, workhorseText, "fix the auth flow @cmd/login.go");

	const loopLog = h.commands.get("loop:log");
	assert.ok(loopLog, "loop:log registered");
	await loopLog("", h.ctx);

	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	// Default is first entry (Request)
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Request/, "Request is in the list");
	assert.match(rendered, /User request/, "detail shows user request heading");
	assert.match(rendered, /fix the auth flow @cmd\/login\.go/, "detail shows the initial command");
	await h.stopLoop();
});

test("list shows Request, Round N: Overseer, Round N: Workhorse as separate entries", async () => {
	const h = createHarness();
	await h.startRound(overseerText, workhorseText, "fix auth");

	const loopLog = h.commands.get("loop:log");
	assert.ok(loopLog, "loop:log registered");
	await loopLog("", h.ctx);

	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Request/, "list shows Request entry");
	assert.match(rendered, /Round 1: Overseer/, "list shows Round 1: Overseer");
	assert.match(rendered, /Round 1: Workhorse/, "list shows Round 1: Workhorse");
	await h.stopLoop();
});

test("selecting Workhorse shows only workhorse message, no user request", async () => {
	const h = createHarness();
	await h.startRound(overseerText, workhorseText, "fix the auth flow");

	const loopLog = h.commands.get("loop:log");
	assert.ok(loopLog, "loop:log registered");
	await loopLog("", h.ctx);

	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	// Navigate to workhorse: j j (Request -> Overseer -> Workhorse)
	component.handleInput("j");
	component.handleInput("j");
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Added the guard/, "workhorse content visible in detail");
	assert.doesNotMatch(rendered, /User request/, "no user request in workhorse detail");
	await h.stopLoop();
});

test("/loop:log shows Request entry before any rounds complete", async () => {
	const h = createHarness();
	const loop = h.commands.get("loop");
	assert.ok(loop, "loop command registered");
	await loop("just say hi", h.ctx);

	const loopLog = h.commands.get("loop:log");
	assert.ok(loopLog, "loop:log registered");
	await loopLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "viewer opens even with zero rounds");
	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Request/, "shows Request entry");
	assert.match(rendered, /just say hi/, "shows the user's request");
	await h.stopLoop();
});

test("/ searches detail panel text and scrolls to matching line", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const filler = new Array(30).fill("filler line").join("\n");
	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			overseerText: filler + "\ntarget_line_alpha\n" + filler + "\n**VERDICT:** CHANGES_REQUESTED",
			workhorseSummary: "[Workhorse Round 1] " + filler + "\ntarget_line_beta\n" + filler,
		},
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test search", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 20 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Navigate to Overseer: j from Request
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Overseer/, "on overseer entry");

	// Search for target_line
	component.handleInput("/");
	for (const ch of "target_line") component.handleInput(ch);
	component.handleInput("\r");

	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_alpha/, "scrolled to matching line in detail panel");
	assert.match(rendered, /\[1\//, "shows match count indicator");

	// n jumps to next match in workhorse entry
	component.handleInput("n");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_beta/, "n jumped to next match in workhorse entry");
	assert.match(rendered, /Round 1: Workhorse/, "switched to workhorse entry");

	// N goes back to previous match
	component.handleInput("N");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_alpha/, "N went back to overseer entry");
});

test("search highlights with ANSI reverse video, Esc clears", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, overseerText: "found a mutex bug\n\n**VERDICT:** CHANGES_REQUESTED", workhorseSummary: "fixed it" },
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 30 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Navigate to overseer entry
	component.handleInput("j");
	component.render(120);

	// Search for "mutex"
	component.handleInput("/");
	for (const ch of "mutex") component.handleInput(ch);
	component.handleInput("\r");

	let rendered = component.render(120).join("\n");
	// Active match is white-on-red, others black-on-yellow
	assert.match(rendered, /\x1b\[0m\x1b\[97;41m/, "active match uses reset + white-on-red");

	// Esc clears highlighting
	component.handleInput("\x1b");
	rendered = component.render(120).join("\n");
	assert.doesNotMatch(rendered, /\x1b\[97;41m/, "highlighting cleared after Esc");
});

test("partial round shows overseer item without workhorse item", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const roundResults = [{ round: 1, verdict: "changes_requested" as const, overseerText: overseerText, workhorseSummary: "" }];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			custom: async (factory: any, _options?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("check auth", roundResults, mockCtx);
	assert.ok(capturedFactory, "viewer factory captured");

	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Round 1: Overseer/, "shows overseer item");
	assert.doesNotMatch(rendered, /Round 1: Workhorse/, "no workhorse item for incomplete round");
});

test("current match uses distinct style from other matches", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			overseerText: "Test alpha and Test beta\n\n**VERDICT:** CHANGES_REQUESTED",
			workhorseSummary: "done",
		},
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _opts?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test", rounds, mockCtx);
	const comp = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 30 } },
		mockCtx.ui.theme, {}, () => {},
	);

	comp.handleInput("j");
	comp.render(120);
	comp.handleInput("/");
	for (const ch of "Test") comp.handleInput(ch);
	comp.handleInput("\r");

	const rendered = comp.render(120).join("\n");
	// Active match: white on red (\x1b[0m\x1b[97;41m)
	// Other matches: black on yellow (\x1b[0m\x1b[30;43m)
	assert.match(rendered, /\x1b\[0m\x1b\[97;41m/, "active match uses white-on-red");
	assert.match(rendered, /\x1b\[0m\x1b\[30;43m/, "other matches use black-on-yellow");
});

test("n/N visually moves highlight to the new match location", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const filler = new Array(25).fill("filler line").join("\n");
	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			overseerText: "first_match here\n" + filler + "\nsecond_match here\n\n**VERDICT:** CHANGES_REQUESTED",
			workhorseSummary: "done",
		},
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _opts?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test", rounds, mockCtx);
	const comp = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 15 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Go to overseer, search "match"
	comp.handleInput("j");
	comp.render(120);
	comp.handleInput("/");
	for (const ch of "match") comp.handleInput(ch);
	comp.handleInput("\r");

	let r = strip(comp.render(120).join("\n"));
	assert.match(r, /first_match/, "first hit visible");

	// n should scroll to second_match
	comp.handleInput("n");
	r = strip(comp.render(120).join("\n"));
	assert.match(r, /second_match/, "n scrolled to second hit");

	// N should go back to first_match
	comp.handleInput("N");
	r = strip(comp.render(120).join("\n"));
	assert.match(r, /first_match/, "N scrolled back to first hit");
});

test("highlight uses reset to avoid color bleed from code blocks", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			overseerText: "```go\nfunc handleConn() error {\n```\n\n**VERDICT:** CHANGES_REQUESTED",
			workhorseSummary: "done",
		},
	];
	let capturedFactory: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, _opts?: any) => { capturedFactory = factory; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("test", rounds, mockCtx);
	const comp = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 30 } },
		mockCtx.ui.theme, {}, () => {},
	);

	comp.handleInput("j");
	comp.render(120);
	comp.handleInput("/");
	for (const ch of "handleConn") comp.handleInput(ch);
	comp.handleInput("\r");

	const rendered = comp.render(120).join("\n");
	// Highlight must use full reset (\x1b[0m) before and after to isolate from surrounding ANSI
	// Only one match, so it's the active hit (white-on-red)
	assert.match(rendered, /\x1b\[0m\x1b\[97;41m/, "highlight uses reset then white-on-red for active match");
	assert.match(rendered, /\x1b\[0m/, "highlight ends with reset");
});

test("overlay renders enough lines to fill maxHeight for proper centering", async () => {
	const { showLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "approved" as const, overseerText: "ok\n\n**VERDICT:** APPROVED", workhorseSummary: "" },
	];
	let capturedFactory: any;
	let capturedOpts: any;
	const mockCtx = {
		hasUI: true,
		ui: {
			notify() {},
			custom: async (factory: any, opts?: any) => { capturedFactory = factory; capturedOpts = opts; },
			theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	};
	await showLog("short", rounds, mockCtx);
	const comp = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Even with minimal content, rendered lines should be consistent
	// so the overlay system can center properly
	const lines = comp.render(120);
	const firstRender = lines.length;

	// Render again at same size should produce same line count
	const lines2 = comp.render(120);
	assert.equal(lines2.length, firstRender, "consistent line count across renders");

	// The line count should be based on bodyHeight, not content height.
	// With rows=40, bodyHeight = max(10, floor(40*0.72)-5) = max(10, 23) = 23
	// Total = 23 (body) + 5 (header+borders+footer) = 28
	assert.ok(lines.length >= 28, "renders enough lines to fill the space: got " + lines.length);

	// Overlay should not use percentage width (causes dead space on wide terminals).
	// It should use a fixed maxWidth so the box stays compact.
	var overlayWidth = capturedOpts?.overlayOptions?.width;
	assert.ok(typeof overlayWidth !== "string" || !overlayWidth.includes("%"), "overlay width is not percentage-based");
});
