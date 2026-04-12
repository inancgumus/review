import type { RoundResult } from "./types.js";
import { loadPiAgent, loadTui } from "./tui-runtime.js";
import { VERDICT_STRIP_RE } from "./verdicts.js";

function formatDuration(ms: number): string {
	var s = Math.floor(ms / 1000);
	var m = Math.floor(s / 60);
	var h = Math.floor(m / 60);
	if (h > 0) return h + "h " + (m % 60) + "m";
	if (m > 0) return m + "m " + (s % 60) + "s";
	return s + "s";
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

const MIN_WIDTH = 60;
const MAX_WIDTH = 120;
const LIST_WIDTH = 28;

type ListEntry =
	| { type: "request"; text: string; startedAt: number }
	| { type: "overseer"; round: number; result: RoundResult }
	| { type: "workhorse"; round: number; result: RoundResult };

interface SearchHit { entryIdx: number; lineIdx: number; }

type Panel = "list" | "detail";

function verdictLabel(result: RoundResult): string {
	return (result.verdict ?? "pending").toUpperCase();
}

function verdictIcon(result: RoundResult): string {
	return result.verdict === "approved" ? "\u2705" : result.verdict === "changes_requested" ? "\u274c" : "\u23f3";
}

function preview(text: string): string {
	for (const line of text.split("\n")) {
		const clean = line
			.replace(/^\s*#+\s*/, "")
			.replace(/^\s*[-*+]\s*/, "")
			.replace(/\*\*/g, "")
			.trim();
		if (clean) return clean;
	}
	return "";
}

function pad(
	text: string,
	width: number,
	truncateToWidth: (text: string, width: number, ellipsis?: string, preserveAnsi?: boolean) => string,
	visibleWidth: (text: string) => number,
): string {
	const clipped = truncateToWidth(text, width, "...", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function cleanOverseerText(text: string): string {
	return text
		.replace(VERDICT_STRIP_RE, "")
		.trim();
}

function cleanWorkhorseText(text: string): string {
	return text.replace(/^\[Workhorse Round \d+\]\s*/i, "").trim();
}

function buildEntries(initialRequest: string, roundResults: RoundResult[], loopStartedAt: number): ListEntry[] {
	var entries: ListEntry[] = [{ type: "request", text: initialRequest, startedAt: loopStartedAt }];
	for (var i = 0; i < roundResults.length; i++) {
		var result = roundResults[i];
		entries.push({ type: "overseer", round: result.round, result: result });
		if (result.workhorseSummary.trim()) {
			entries.push({ type: "workhorse", round: result.round, result: result });
		}
	}
	return entries;
}

function buildEntryMarkdown(entry: ListEntry): string {
	if (entry.type === "request") {
		var started = "";
		if (entry.startedAt) {
			started = "\n\n**Started:** " + formatTime(entry.startedAt);
		}
		return "# User request" + started + "\n\n" + (entry.text ? ("`" + entry.text + "`") : "_No user request recorded._");
	}
	if (entry.type === "overseer") {
		var timing = "";
		if (entry.result.startedAt && entry.result.endedAt) {
			timing = "\n\n\u23f1 " + formatDuration(entry.result.endedAt - entry.result.startedAt) +
				" (" + formatTime(entry.result.startedAt) + " \u2192 " + formatTime(entry.result.endedAt) + ")";
		}
		return "# Round " + entry.round + ": Overseer\n\n**Verdict:** " + verdictLabel(entry.result) + timing + "\n\n" +
			(cleanOverseerText(entry.result.overseerText) || "_No overseer output recorded._");
	}
	var wTiming = "";
	if (entry.result.workhorseStartedAt && entry.result.endedAt) {
		wTiming = "\n\n\u23f1 " + formatDuration(entry.result.endedAt - entry.result.workhorseStartedAt) +
			" (" + formatTime(entry.result.workhorseStartedAt) + " \u2192 " + formatTime(entry.result.endedAt) + ")";
	}
	return "# Round " + entry.round + ": Workhorse" + wTiming + "\n\n" +
		(cleanWorkhorseText(entry.result.workhorseSummary) || "_No workhorse output recorded._");
}

function entryTitle(entry: ListEntry): string {
	if (entry.type === "request") return "\ud83d\udcdd Request";
	if (entry.type === "overseer") return verdictIcon(entry.result) + " Round " + entry.round + ": Overseer";
	return "\ud83d\udd27 Round " + entry.round + ": Workhorse";
}

function entrySubtitle(entry: ListEntry): string {
	if (entry.type === "request") return preview(entry.text) || "No request";
	if (entry.type === "overseer") return preview(cleanOverseerText(entry.result.overseerText)) || "No details yet";
	return preview(cleanWorkhorseText(entry.result.workhorseSummary)) || "No details yet";
}

function buildListLines(
	entries: ListEntry[],
	selected: number,
	theme: any,
	width: number,
	truncateToWidth: (text: string, width: number, ellipsis?: string, preserveAnsi?: boolean) => string,
	visibleWidth: (text: string) => number,
): string[] {
	var lines = [theme.fg("accent", theme.bold("Log")), ""];
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i];
		var active = i === selected;
		var prefix = active ? theme.fg("accent", "\u25b6") : " ";
		var title = prefix + " " + entryTitle(entry);
		var subtitle = entrySubtitle(entry);
		lines.push(pad(title, width, truncateToWidth, visibleWidth));
		lines.push(pad(theme.fg(active ? "text" : "dim", "  " + subtitle), width, truncateToWidth, visibleWidth));
		lines.push("");
	}
	return lines;
}

function headerTitle(entry: ListEntry): string {
	if (entry.type === "request") return " \ud83d\udcdd Request ";
	if (entry.type === "overseer") {
		var dur = "";
		if (entry.result.startedAt && entry.result.endedAt) {
			dur = " \u00b7 \u23f1 " + formatDuration(entry.result.endedAt - entry.result.startedAt);
		}
		return " " + verdictIcon(entry.result) + " Round " + entry.round + ": Overseer \u00b7 " + verdictLabel(entry.result) + dur + " ";
	}
	var wDur = "";
	if (entry.result.workhorseStartedAt && entry.result.endedAt) {
		wDur = " \u00b7 \u23f1 " + formatDuration(entry.result.endedAt - entry.result.workhorseStartedAt);
	}
	return " \ud83d\udd27 Round " + entry.round + ": Workhorse" + wDur + " ";
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Highlight search matches in a rendered line.
// activeOccurrence: which match on this line is the active hit (0-based), -1 if none.
// Active match = white on red, others = black on yellow.
function highlightLine(line: string, query: string, activeOccurrence: number): string {
	if (!query) return line;
	var hlNormal = "\x1b[0m\x1b[30;43m";
	var hlActive = "\x1b[0m\x1b[97;41m";
	var matchCount = 0;
	var qLower = query.toLowerCase();
	var parts: string[] = [];
	var last = 0;
	var ansiRe = /\x1b\[[0-9;]*m/g;
	var m: RegExpExecArray | null;
	while ((m = ansiRe.exec(line)) !== null) {
		if (m.index > last) parts.push(line.slice(last, m.index));
		parts.push(m[0]);
		last = m.index + m[0].length;
	}
	if (last < line.length) parts.push(line.slice(last));

	var result: string[] = [];
	for (var pi2 = 0; pi2 < parts.length; pi2++) {
		var part = parts[pi2];
		if (part.startsWith("\x1b[")) {
			result.push(part);
			continue;
		}
		var idx = 0;
		var lower = part.toLowerCase();
		while (idx < part.length) {
			var pos = lower.indexOf(qLower, idx);
			if (pos === -1) {
				result.push(part.slice(idx));
				break;
			}
			if (pos > idx) result.push(part.slice(idx, pos));
			var style = (matchCount === activeOccurrence) ? hlActive : hlNormal;
			result.push(style + part.slice(pos, pos + query.length) + "\x1b[0m");
			matchCount++;
			idx = pos + query.length;
		}
	}
	return result.join("");
}

export async function showLog(initialRequest: string, roundResults: RoundResult[], ctx: any, loopStartedAt?: number): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/loop:log requires interactive mode", "error");
		return;
	}

	var loaded = await Promise.all([loadTui(), loadPiAgent()]);
	var Markdown = loaded[0].Markdown;
	var matchesKey = loaded[0].matchesKey;
	var truncateToWidth = loaded[0].truncateToWidth;
	var visibleWidth = loaded[0].visibleWidth;
	var mdTheme = loaded[1].getMarkdownTheme();

	await ctx.ui.custom(function (tui: any, theme: any, _kb: any, done: () => void) {
		var entries = buildEntries(initialRequest, roundResults, loopStartedAt || 0);
		var selected = 0;
		var scroll = 0;
		var focus: Panel = "list";
		var cachedIdx = -1;
		var cachedWidth = -1;
		var cachedLines: string[] = [];
		var lastRenderWidth = MIN_WIDTH;

		var searchMode = false;
		var searchQuery = "";
		var activeHighlight = "";
		var searchHits: SearchHit[] = [];
		var searchHitIdx = -1;

		var entryLinesCache = new Map();

		function bodyHeight(): number {
			return Math.max(10, Math.floor(tui.terminal.rows * 0.72) - 5);
		}

		function innerWidth(width: number): number {
			return Math.max(MIN_WIDTH - 2, Math.min(MAX_WIDTH, width) - 2);
		}

		function detailWidth(width: number): number {
			return Math.max(24, innerWidth(width) - LIST_WIDTH - 3);
		}

		function renderEntryLines(entryIdx: number, width: number): string[] {
			var w = detailWidth(width);
			var key = entryIdx + ":" + w;
			var cached = entryLinesCache.get(key);
			if (cached) return cached;
			var md = new Markdown(buildEntryMarkdown(entries[entryIdx]!), 0, 0, mdTheme);
			var lines = md.render(w);
			entryLinesCache.set(key, lines);
			return lines;
		}

		function detailLines(width: number): string[] {
			var w = detailWidth(width);
			if (cachedIdx === selected && cachedWidth === w) return cachedLines;
			cachedIdx = selected;
			cachedWidth = w;
			cachedLines = renderEntryLines(selected, width);
			return cachedLines;
		}

		function clampScroll(width: number): void {
			var max = Math.max(0, detailLines(width).length - bodyHeight());
			scroll = Math.max(0, Math.min(scroll, max));
		}

		function repaint(): void {
			clampScroll(lastRenderWidth);
			tui.requestRender();
		}

		function selectEntry(idx: number): void {
			if (idx < 0 || idx >= entries.length) return;
			if (idx !== selected) {
				selected = idx;
				scroll = 0;
			}
			repaint();
		}

		function moveEntry(delta: number): void {
			selectEntry(Math.max(0, Math.min(entries.length - 1, selected + delta)));
		}

		function scrollDetail(delta: number): void {
			scroll += delta;
			repaint();
		}

		function scrollToLine(lineIdx: number): void {
			scroll = Math.max(0, lineIdx - Math.floor(bodyHeight() / 2));
			repaint();
		}

		function runSearch(): void {
			searchHits = [];
			searchHitIdx = -1;
			activeHighlight = searchQuery;
			if (!searchQuery) { activeHighlight = ""; return; }

			var q = searchQuery.toLowerCase();
			var w = lastRenderWidth;
			for (var ei = 0; ei < entries.length; ei++) {
				var lines = renderEntryLines(ei, w);
				for (var li = 0; li < lines.length; li++) {
					var plain = stripAnsi(lines[li]).toLowerCase();
					var searchIdx = 0;
					while (true) {
						var found = plain.indexOf(q, searchIdx);
						if (found === -1) break;
						searchHits.push({ entryIdx: ei, lineIdx: li });
						searchIdx = found + q.length;
					}
				}
			}

			if (searchHits.length === 0) return;

			var best = 0;
			for (var si = 0; si < searchHits.length; si++) {
				var h = searchHits[si];
				if (h.entryIdx > selected || (h.entryIdx === selected && h.lineIdx >= scroll)) {
					best = si;
					break;
				}
			}
			searchHitIdx = best;
			jumpToHit(searchHitIdx);
		}

		function jumpToHit(idx: number): void {
			if (idx < 0 || idx >= searchHits.length) return;
			var hit = searchHits[idx];
			selected = hit.entryIdx;
			cachedIdx = -1;
			cachedWidth = -1;
			scrollToLine(hit.lineIdx);
		}

		function searchNext(): void {
			if (searchHits.length === 0) return;
			searchHitIdx = (searchHitIdx + 1) % searchHits.length;
			jumpToHit(searchHitIdx);
		}

		function searchPrev(): void {
			if (searchHits.length === 0) return;
			searchHitIdx = (searchHitIdx - 1 + searchHits.length) % searchHits.length;
			jumpToHit(searchHitIdx);
		}

		function clearSearch(): void {
			searchQuery = "";
			activeHighlight = "";
			searchHits = [];
			searchHitIdx = -1;
		}

		function helpText(): string {
			if (searchMode) {
				return " /" + searchQuery + "_ (Enter confirm, Esc cancel) ";
			}
			var focusLabel = focus === "list" ? "[list]" : "[detail]";
			return " Tab switch " + focusLabel + " \u00b7 j/k nav \u00b7 d/u page \u00b7 g/G top/end \u00b7 /search n/N \u00b7 q/Esc close ";
		}

		function searchInfo(): string {
			if (!activeHighlight) return "";
			if (searchHits.length === 0) return " [no matches]";
			return " [" + (searchHitIdx + 1) + "/" + searchHits.length + "]";
		}

		return {
			render: function (width: number): string[] {
				lastRenderWidth = width;
				clampScroll(width);

				var inner = innerWidth(width);
				var listWidth = Math.min(LIST_WIDTH, Math.max(20, inner - 27));
				var detailW = Math.max(24, inner - listWidth - 3);
				var height = bodyHeight();
				var current = entries[selected]!;
				var list = buildListLines(entries, selected, theme, listWidth, truncateToWidth, visibleWidth);
				var detail = detailLines(width).slice(scroll, scroll + height);

				if (activeHighlight) {
					// Find active hit's viewport-relative line and occurrence
					var activeViewLine = -1;
					var activeOccurrence = -1;
					if (searchHitIdx >= 0 && searchHitIdx < searchHits.length) {
						var hit = searchHits[searchHitIdx];
						if (hit.entryIdx === selected) {
							activeViewLine = hit.lineIdx - scroll;
							// Count how many hits on the same line come before the active one
							activeOccurrence = 0;
							for (var hi = 0; hi < searchHitIdx; hi++) {
								var prev = searchHits[hi];
								if (prev.entryIdx === hit.entryIdx && prev.lineIdx === hit.lineIdx) {
									activeOccurrence++;
								}
							}
						}
					}
					detail = detail.map(function (line: string, i: number) {
						var occ = (i === activeViewLine) ? activeOccurrence : -1;
						return highlightLine(line, activeHighlight, occ);
					});
				}

				var rows: string[] = [];
				var border = function (text: string) { return theme.fg("border", text); };
				var totalElapsed = "";
				if (roundResults.length > 0 && roundResults[0].startedAt && roundResults[roundResults.length - 1].endedAt) {
					totalElapsed = " \u00b7 " + formatDuration(roundResults[roundResults.length - 1].endedAt - roundResults[0].startedAt);
				}
				var header = " Loop Log \u00b7 " + roundResults.length + " round(s)" + totalElapsed + " ";
				var headerPad = Math.max(0, inner - visibleWidth(header));
				var title = headerTitle(current);
				var totalLines = detailLines(width).length;
				var scrollStr = (scroll + 1) + "-" + Math.min(scroll + height, totalLines) + " / " + totalLines + searchInfo();
				var help = helpText();

				rows.push(border("\u256d") + theme.fg("accent", header) + border("\u2500".repeat(headerPad) + "\u256e"));
				rows.push(border("\u2502") + pad(theme.fg("accent", title), inner, truncateToWidth, visibleWidth) + border("\u2502"));
				rows.push(border("\u251c") + border("\u2500".repeat(listWidth + 1)) + border("\u252c") + border("\u2500".repeat(detailW + 1)) + border("\u2524"));

				for (var i = 0; i < height; i++) {
					var left = list[i] ?? "";
					var right = detail[i] ?? "";
					rows.push(
						border("\u2502") +
						pad(left, listWidth + 1, truncateToWidth, visibleWidth) +
						border("\u2502") +
						pad(right, detailW + 1, truncateToWidth, visibleWidth) +
						border("\u2502"),
					);
				}

				rows.push(border("\u251c") + border("\u2500".repeat(inner)) + border("\u2524"));
				rows.push(border("\u2502") + pad(theme.fg("dim", help + "   " + scrollStr), inner, truncateToWidth, visibleWidth) + border("\u2502"));
				rows.push(border("\u2570") + border("\u2500".repeat(inner)) + border("\u256f"));
				return rows;
			},
			invalidate: function (): void {
				cachedIdx = -1;
				cachedWidth = -1;
				cachedLines = [];
				entryLinesCache.clear();
			},
			handleInput: function (data: string): void {
				// Search input mode
				if (searchMode) {
					if (matchesKey(data, "return")) {
						searchMode = false;
						runSearch();
						return void repaint();
					}
					if (matchesKey(data, "escape")) {
						searchMode = false;
						searchQuery = "";
						return void repaint();
					}
					if (matchesKey(data, "backspace")) {
						searchQuery = searchQuery.slice(0, -1);
						return void repaint();
					}
					if (data.length === 1 && data >= " ") {
						searchQuery += data;
						return void repaint();
					}
					return;
				}

				// Esc: clear search first, close on second press
				if (matchesKey(data, "escape")) {
					if (activeHighlight) {
						clearSearch();
						return void repaint();
					}
					done();
					return;
				}

				// Close
				if (matchesKey(data, "return") || data === "q") {
					done();
					return;
				}

				// Tab toggles focus between list and detail
				if (data === "\t") {
					focus = focus === "list" ? "detail" : "list";
					return void repaint();
				}

				// j/k and arrows: context-dependent on focus
				if (focus === "list") {
					if (matchesKey(data, "down") || data === "j") return void moveEntry(1);
					if (matchesKey(data, "up") || data === "k") return void moveEntry(-1);
				} else {
					if (matchesKey(data, "down") || data === "j") return void scrollDetail(1);
					if (matchesKey(data, "up") || data === "k") return void scrollDetail(-1);
				}

				// Half-page: Ctrl+d/Ctrl+u and PgUp/PgDn (always scroll detail)
				var half = Math.max(1, Math.floor(bodyHeight() / 2));
				if (matchesKey(data, "pagedown") || data === "\x04") return void scrollDetail(half);
				if (matchesKey(data, "pageup") || data === "\x15") return void scrollDetail(-half);

				// Top/bottom: g/G and Home/End
				if (focus === "list") {
					if (matchesKey(data, "home") || data === "g") return void selectEntry(0);
					if (matchesKey(data, "end") || data === "G") return void selectEntry(entries.length - 1);
				} else {
					if (matchesKey(data, "home") || data === "g") { scroll = 0; return void repaint(); }
					if (matchesKey(data, "end") || data === "G") { scroll = Number.MAX_SAFE_INTEGER; return void repaint(); }
				}

				// Search
				if (data === "/") {
					searchMode = true;
					searchQuery = "";
					return void repaint();
				}
				if (data === "n") return void searchNext();
				if (data === "N") return void searchPrev();
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: MAX_WIDTH,
			minWidth: MIN_WIDTH,
			maxHeight: "80%",
			margin: 1,
		},
	});
}
