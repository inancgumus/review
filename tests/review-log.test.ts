import assert from "node:assert/strict";
import test from "node:test";
import reviewExtension from "../index.ts";
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

	reviewExtension(pi as any);

	async function startRound(reviewText: string, fixerText: string, initialRequest = "check auth") {
		const review = commands.get("review");
		assert.ok(review, "review command registered");
		await review(initialRequest, ctx);

		leafId = "review-1";
		entries.push({
			id: "review-1",
			type: "message",
			message: { role: "assistant", content: reviewText, stopReason: "end_turn" },
		});
		const agentEnd = events.get("agent_end");
		assert.ok(agentEnd, "agent_end handler registered");
		agentEnd({}, ctx);
		await wait();

		leafId = "fix-1";
		entries.push({
			id: "fix-1",
			type: "message",
			message: { role: "assistant", content: fixerText, stopReason: "end_turn" },
		});
		agentEnd({}, ctx);
		await wait();
	}

	async function stopLoop() {
		const stop = commands.get("review:stop");
		assert.ok(stop, "review:stop registered");
		await stop("", ctx);
	}

	return { commands, ctx, customCalls, selectCalls, sentMessages, userMessages, startRound, stopLoop };
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

const TAB = "\t";

// Strip ANSI for regex matching
function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("live review log includes the user's first review message", async () => {
	const h = createHarness();
	const review = h.commands.get("review");
	assert.ok(review, "review command registered");
	await review("fix the auth flow @cmd/login.go", h.ctx);

	const logLines = h.sentMessages
		.filter(message => message.customType === "review-log")
		.map(message => String(message.content));

	assert.match(logLines.join("\n\n"), /fix the auth flow @cmd\/login\.go/, "logs the initial user request");
	await h.stopLoop();
});

test("/review:log opens a centered overlay viewer with explicit height", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText);

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	assert.equal(h.customCalls.length, 1, "opens a custom viewer");
	assert.equal(h.customCalls[0]?.options?.overlay, true, "uses overlay modal");
	const opts = h.customCalls[0]?.options?.overlayOptions;
	assert.equal(opts?.anchor, "center", "overlay is centered");
	assert.ok(opts?.maxHeight, "overlay has maxHeight for sizing");
	await h.stopLoop();
});

test("Tab switches focus between list and detail panels", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, reviewText: "issue A", fixerSummary: "fixed A" },
		{ round: 2, verdict: "approved" as const, reviewText: "all good", fixerSummary: "" },
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
	await showReviewLog("test tab", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Default focus is list. j moves to next entry.
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Reviewer/, "j moved to reviewer in list");

	// Tab switches to detail panel. j now scrolls detail.
	component.handleInput(TAB);
	component.handleInput("j");
	// Should still be on Round 1: Reviewer (entry didn't change, just scrolled)
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Reviewer/, "still on reviewer after scroll");

	// Tab back to list, j moves to next entry
	component.handleInput(TAB);
	component.handleInput("j");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Fixer/, "j moved to fixer in list");
});

test("j/k navigate entries in list panel, q closes", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, reviewText: "issue A", fixerSummary: "fixed A" },
		{ round: 2, verdict: "approved" as const, reviewText: "all good", fixerSummary: "" },
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
	await showReviewLog("test nav", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {},
		() => { closed = true; },
	);

	// Default = first entry (Request). j moves down to Reviewer.
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Reviewer/, "j moved to reviewer");

	// j again to Fixer
	component.handleInput("j");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Fixer/, "j moved to fixer");

	// k back to Reviewer
	component.handleInput("k");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Reviewer/, "k moved back to reviewer");

	// q closes
	component.handleInput("q");
	assert.ok(closed, "q closed the viewer");
});

test("default selection is first entry (Request), not last", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, reviewText: "review text", fixerSummary: "fixer text" },
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
	await showReviewLog("my request", rounds, mockCtx);
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
	await h.startRound(reviewerText, fixerText, "fix the auth flow @cmd/login.go");

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

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

test("list shows Request, Round N: Reviewer, Round N: Fixer as separate entries", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText, "fix auth");

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Request/, "list shows Request entry");
	assert.match(rendered, /Round 1: Reviewer/, "list shows Round 1: Reviewer");
	assert.match(rendered, /Round 1: Fixer/, "list shows Round 1: Fixer");
	await h.stopLoop();
});

test("selecting Fixer shows only fixer message, no user request", async () => {
	const h = createHarness();
	await h.startRound(reviewerText, fixerText, "fix the auth flow");

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

	const viewer = h.customCalls[0];
	const { initTheme } = await loadPiAgent();
	initTheme();
	const component = await viewer.factory(
		{ requestRender() {}, terminal: { rows: 40 } },
		h.ctx.ui.theme, {}, () => {},
	);
	// Navigate to fixer: j j (Request -> Reviewer -> Fixer)
	component.handleInput("j");
	component.handleInput("j");
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Added the guard/, "fixer content visible in detail");
	assert.doesNotMatch(rendered, /User request/, "no user request in fixer detail");
	await h.stopLoop();
});

test("/review:log shows Request entry before any rounds complete", async () => {
	const h = createHarness();
	const review = h.commands.get("review");
	assert.ok(review, "review command registered");
	await review("just say hi", h.ctx);

	const reviewLog = h.commands.get("review:log");
	assert.ok(reviewLog, "review:log registered");
	await reviewLog("", h.ctx);

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
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const filler = new Array(30).fill("filler line").join("\n");
	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			reviewText: filler + "\ntarget_line_alpha\n" + filler + "\n**VERDICT:** CHANGES_REQUESTED",
			fixerSummary: "[Fixer Round 1] " + filler + "\ntarget_line_beta\n" + filler,
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
	await showReviewLog("test search", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 20 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Navigate to Reviewer: j from Request
	component.handleInput("j");
	let rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /Round 1: Reviewer/, "on reviewer entry");

	// Search for target_line
	component.handleInput("/");
	for (const ch of "target_line") component.handleInput(ch);
	component.handleInput("\r");

	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_alpha/, "scrolled to matching line in detail panel");
	assert.match(rendered, /\[1\//, "shows match count indicator");

	// n jumps to next match in fixer entry
	component.handleInput("n");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_beta/, "n jumped to next match in fixer entry");
	assert.match(rendered, /Round 1: Fixer/, "switched to fixer entry");

	// N goes back to previous match
	component.handleInput("N");
	rendered = strip(component.render(120).join("\n"));
	assert.match(rendered, /target_line_alpha/, "N went back to reviewer entry");
});

test("search highlights with ANSI reverse video, Esc clears", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "changes_requested" as const, reviewText: "found a mutex bug\n\n**VERDICT:** CHANGES_REQUESTED", fixerSummary: "fixed it" },
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
	await showReviewLog("test", rounds, mockCtx);
	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 30 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Navigate to reviewer entry
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

test("partial round shows reviewer item without fixer item", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const roundResults = [{ round: 1, verdict: "changes_requested" as const, reviewText: reviewerText, fixerSummary: "" }];
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
	await showReviewLog("check auth", roundResults, mockCtx);
	assert.ok(capturedFactory, "viewer factory captured");

	const component = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 40 } },
		mockCtx.ui.theme, {}, () => {},
	);
	const rendered = strip(component.render(120).join("\n"));

	assert.match(rendered, /Round 1: Reviewer/, "shows reviewer item");
	assert.doesNotMatch(rendered, /Round 1: Fixer/, "no fixer item for incomplete round");
});

test("current match uses distinct style from other matches", async () => {
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			reviewText: "Test alpha and Test beta\n\n**VERDICT:** CHANGES_REQUESTED",
			fixerSummary: "done",
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
	await showReviewLog("test", rounds, mockCtx);
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
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const filler = new Array(25).fill("filler line").join("\n");
	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			reviewText: "first_match here\n" + filler + "\nsecond_match here\n\n**VERDICT:** CHANGES_REQUESTED",
			fixerSummary: "done",
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
	await showReviewLog("test", rounds, mockCtx);
	const comp = await capturedFactory(
		{ requestRender() {}, terminal: { rows: 15 } },
		mockCtx.ui.theme, {}, () => {},
	);

	// Go to reviewer, search "match"
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
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{
			round: 1, verdict: "changes_requested" as const,
			reviewText: "```go\nfunc handleConn() error {\n```\n\n**VERDICT:** CHANGES_REQUESTED",
			fixerSummary: "done",
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
	await showReviewLog("test", rounds, mockCtx);
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
	const { showReviewLog } = await import("../log-view.ts");
	const { initTheme } = await loadPiAgent();
	initTheme();

	const rounds = [
		{ round: 1, verdict: "approved" as const, reviewText: "ok\n\n**VERDICT:** APPROVED", fixerSummary: "" },
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
	await showReviewLog("short", rounds, mockCtx);
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
