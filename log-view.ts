import type { RoundResult } from "./types.js";
import { loadPiAgent, loadTui } from "./tui-runtime.js";

const MIN_WIDTH = 60;
const MAX_WIDTH = 120;
const LIST_WIDTH = 28;

function verdictLabel(result: RoundResult): string {
	return (result.verdict ?? "pending").toUpperCase();
}

function verdictIcon(result: RoundResult): string {
	return result.verdict === "approved" ? "✅" : result.verdict === "changes_requested" ? "❌" : "⏳";
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

function pad(text: string, width: number, truncateToWidth: (text: string, width: number, ellipsis?: string, preserveAnsi?: boolean) => string, visibleWidth: (text: string) => number): string {
	const clipped = truncateToWidth(text, width, "...", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function cleanReviewerText(text: string): string {
	return text
		.replace(/\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}(APPROVED|CHANGES_REQUESTED)\*{0,2}/gi, "")
		.trim();
}

function cleanFixerText(text: string): string {
	return text.replace(/^\[Fixer Round \d+\]\s*/i, "").trim();
}

function buildRoundMarkdown(initialRequest: string, result: RoundResult): string {
	const parts = [
		`# Round ${result.round}`,
		"",
		"## User request",
		"",
		initialRequest ? `\`${initialRequest}\`` : "_No user request recorded._",
		"",
		`**Verdict:** ${verdictLabel(result)}`,
		"",
		"## Reviewer",
		"",
		cleanReviewerText(result.reviewText) || "_No reviewer output recorded._",
	];

	if (result.fixerSummary.trim()) {
		parts.push("", "## Fixer", "", cleanFixerText(result.fixerSummary) || "_No fixer output recorded._");
	}

	return parts.join("\n");
}

function buildListLines(
	rounds: RoundResult[],
	selected: number,
	theme: any,
	width: number,
	truncateToWidth: (text: string, width: number, ellipsis?: string, preserveAnsi?: boolean) => string,
	visibleWidth: (text: string) => number,
): string[] {
	const lines = [theme.fg("accent", theme.bold("Rounds")), ""];

	for (let i = 0; i < rounds.length; i++) {
		const round = rounds[i];
		const active = i === selected;
		const prefix = active ? theme.fg("accent", "▶") : " ";
		const title = `${prefix} ${verdictIcon(round)} Round ${round.round}`;
		const verdict = active ? theme.fg("accent", verdictLabel(round)) : theme.fg("muted", verdictLabel(round));
		const reviewPreview = preview(cleanReviewerText(round.reviewText));
		const fixerPreview = preview(cleanFixerText(round.fixerSummary));
		const summary = reviewPreview || fixerPreview || "No details yet";
		lines.push(pad(`${title} ${verdict}`, width, truncateToWidth, visibleWidth));
		lines.push(pad(theme.fg(active ? "text" : "dim", `  ${summary}`), width, truncateToWidth, visibleWidth));
		if (fixerPreview) {
			lines.push(pad(theme.fg("dim", `  Fixer: ${fixerPreview}`), width, truncateToWidth, visibleWidth));
		}
		lines.push("");
	}

	return lines;
}

export async function showReviewLog(initialRequest: string, roundResults: RoundResult[], ctx: any): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/review:log requires interactive mode", "error");
		return;
	}

	const [{ Markdown, matchesKey, truncateToWidth, visibleWidth }, { getMarkdownTheme }] = await Promise.all([
		loadTui(),
		loadPiAgent(),
	]);
	const mdTheme = getMarkdownTheme();

	await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: () => void) => {
		let selected = Math.max(0, roundResults.length - 1);
		let scroll = 0;
		let cachedRound = -1;
		let cachedWidth = -1;
		let cachedLines: string[] = [];
		let lastRenderWidth = MIN_WIDTH;

		function bodyHeight(): number {
			return Math.max(10, Math.floor(tui.terminal.rows * 0.72) - 5);
		}

		function innerWidth(width: number): number {
			return Math.max(MIN_WIDTH - 2, Math.min(MAX_WIDTH, width) - 2);
		}

		function detailWidth(width: number): number {
			return Math.max(24, innerWidth(width) - LIST_WIDTH - 3);
		}

		function detailLines(width: number): string[] {
			const w = detailWidth(width);
			if (cachedRound === selected && cachedWidth === w) return cachedLines;
			const markdown = new Markdown(buildRoundMarkdown(initialRequest, roundResults[selected]!), 0, 0, mdTheme);
			cachedRound = selected;
			cachedWidth = w;
			cachedLines = markdown.render(w);
			return cachedLines;
		}

		function clampScroll(width: number): void {
			const max = Math.max(0, detailLines(width).length - bodyHeight());
			scroll = Math.max(0, Math.min(scroll, max));
		}

		function repaint(): void {
			clampScroll(lastRenderWidth);
			tui.requestRender();
		}

		function moveRound(delta: number): void {
			const next = Math.max(0, Math.min(roundResults.length - 1, selected + delta));
			if (next === selected) return;
			selected = next;
			scroll = 0;
			repaint();
		}

		function scrollDetail(delta: number): void {
			scroll += delta;
			repaint();
		}

		return {
			render(width: number): string[] {
				lastRenderWidth = width;
				clampScroll(width);

				const inner = innerWidth(width);
				const listWidth = Math.min(LIST_WIDTH, Math.max(20, inner - 27));
				const detailW = Math.max(24, inner - listWidth - 3);
				const height = bodyHeight();
				const current = roundResults[selected]!;
				const list = buildListLines(roundResults, selected, theme, listWidth, truncateToWidth, visibleWidth);
				const detail = detailLines(width).slice(scroll, scroll + height);
				const rows: string[] = [];
				const border = (text: string) => theme.fg("border", text);
				const header = ` Review Log · ${roundResults.length} round(s) `;
				const headerPad = Math.max(0, inner - visibleWidth(header));
				const title = ` ${verdictIcon(current)} Round ${current.round} · ${verdictLabel(current)} `;
				const titlePad = Math.max(0, inner - visibleWidth(title));
				const scrollInfo = `${scroll + 1}-${Math.min(scroll + height, detailLines(width).length)} / ${detailLines(width).length}`;
				const help = ` ←→ round • ↑↓ scroll • PgUp/PgDn page • Home/End • Esc close `;

				rows.push(border("╭") + theme.fg("accent", header) + border("─".repeat(headerPad) + "╮"));
				rows.push(border("│") + pad(theme.fg("accent", title), inner, truncateToWidth, visibleWidth) + border("│"));
				rows.push(border("├") + border("─".repeat(listWidth + 1)) + border("┬") + border("─".repeat(detailW + 1)) + border("┤"));

				for (let i = 0; i < height; i++) {
					const left = list[i] ?? "";
					const right = detail[i] ?? "";
					rows.push(
						border("│") +
						pad(left, listWidth + 1, truncateToWidth, visibleWidth) +
						border("│") +
						pad(right, detailW + 1, truncateToWidth, visibleWidth) +
						border("│"),
					);
				}

				rows.push(border("├") + border("─".repeat(inner)) + border("┤"));
				rows.push(border("│") + pad(theme.fg("dim", `${help}   ${scrollInfo}`), inner, truncateToWidth, visibleWidth) + border("│"));
				rows.push(border("╰") + border("─".repeat(inner)) + border("╯"));
				return rows;
			},
			invalidate(): void {
				cachedRound = -1;
				cachedWidth = -1;
				cachedLines = [];
			},
			handleInput(data: string): void {
				if (matchesKey(data, "escape") || matchesKey(data, "return")) {
					done();
					return;
				}
				if (matchesKey(data, "left")) return void moveRound(-1);
				if (matchesKey(data, "right")) return void moveRound(1);
				if (matchesKey(data, "up")) return void scrollDetail(-1);
				if (matchesKey(data, "down")) return void scrollDetail(1);
				if (matchesKey(data, "pageup")) return void scrollDetail(-bodyHeight());
				if (matchesKey(data, "pagedown")) return void scrollDetail(bodyHeight());
				if (matchesKey(data, "home")) { scroll = 0; return void repaint(); }
				if (matchesKey(data, "end")) { scroll = Number.MAX_SAFE_INTEGER; return void repaint(); }
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "90%",
			maxHeight: "80%",
			margin: 1,
		},
	});
}
