import { extractText } from "./session.js";

interface RecoveredState {
	focus: string;
	round: number;
	phase: "review" | "fix";
	lastReviewText: string;
	reviewLeafId: string | null;
}

export function reconstructState(ctx: any): RecoveredState | null {
	const entries = ctx.sessionManager.getBranch();
	let lastFixerRound = 0;
	let lastReviewText = "";
	let lastReviewRound = 0;
	let focus = "all recent code changes";
	let reviewLeafId: string | null = null;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];

		if (e.type === "custom_message" && (e as any).customType === "fixer-summary") {
			const text = extractText((e as any).content);
			const m = text.match(/\[Fixer Round (\d+)\]/);
			if (m && lastFixerRound === 0) lastFixerRound = parseInt(m[1], 10);
			continue;
		}

		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg.role !== "assistant" || lastReviewRound !== 0) continue;

		const text = extractText(msg.content);
		if (/VERDICT:\s*\*{0,2}APPROVED\*{0,2}/i.test(text)) return null;

		if (/VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/i.test(text)) {
			lastReviewText = text;
			reviewLeafId = e.id;
			lastReviewRound = findReviewRound(entries, i);
			focus = findFocus(entries, i) || focus;
			break;
		}
	}

	if (lastFixerRound > 0 && lastFixerRound >= lastReviewRound) {
		return { focus, round: lastFixerRound + 1, phase: "review", lastReviewText: "", reviewLeafId };
	}
	if (lastReviewRound > 0 && lastReviewText) {
		return { focus, round: lastReviewRound, phase: "fix", lastReviewText, reviewLeafId };
	}
	return null;
}

function findReviewRound(entries: any[], fromIdx: number): number {
	for (let j = fromIdx - 1; j >= 0; j--) {
		const e = entries[j];
		if (e.type !== "message" || e.message.role !== "user") continue;
		const text = extractText(e.message.content);
		const m = text.match(/Re-review round (\d+)/);
		return m ? parseInt(m[1], 10) : 1;
	}
	return 1;
}

function findFocus(entries: any[], fromIdx: number): string | null {
	for (let j = fromIdx - 1; j >= 0; j--) {
		const e = entries[j];
		if (e.type !== "message" || e.message.role !== "user") continue;
		const text = extractText(e.message.content);
		const m = text.match(/Focus:\s*(.+)/);
		return m ? m[1].trim() : null;
	}
	return null;
}
