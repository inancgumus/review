import { extractText } from "./session.js";
import { matchVerdict } from "./verdicts.js";

interface RecoveredState {
	focus: string;
	round: number;
	phase: "oversee" | "workhorse";
	lastOverseerText: string;
	overseerLeafId: string | null;
}

export function reconstructState(ctx: any): RecoveredState | null {
	const entries = ctx.sessionManager.getBranch();
	let lastWorkhorseRound = 0;
	let lastOverseerText = "";
	let lastOverseerRound = 0;
	let focus = "all recent code changes";
	let overseerLeafId: string | null = null;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];

		if (e.type === "custom_message" && (e as any).customType === "workhorse-summary") {
			const text = extractText((e as any).content);
			const m = text.match(/\[Workhorse Round (\d+)\]/);
			if (m && lastWorkhorseRound === 0) lastWorkhorseRound = parseInt(m[1], 10);
			continue;
		}

		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg.role !== "assistant" || lastOverseerRound !== 0) continue;

		const text = extractText(msg.content);
		const verdict = matchVerdict(text);
		if (verdict === "approved") return null;

		if (verdict === "changes_requested") {
			lastOverseerText = text;
			overseerLeafId = e.id;
			lastOverseerRound = findOverseerRound(entries, i);
			focus = findFocus(entries, i) || focus;
			break;
		}
	}

	if (lastWorkhorseRound > 0 && lastWorkhorseRound >= lastOverseerRound) {
		return { focus, round: lastWorkhorseRound + 1, phase: "oversee", lastOverseerText: "", overseerLeafId };
	}
	if (lastOverseerRound > 0 && lastOverseerText) {
		return { focus, round: lastOverseerRound, phase: "workhorse", lastOverseerText, overseerLeafId };
	}
	return null;
}

function findOverseerRound(entries: any[], fromIdx: number): number {
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
