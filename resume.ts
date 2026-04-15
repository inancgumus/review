/**
 * Resume — reconstruct loop state from session history.
 * Used by all modes (fresh, incremental, exec) to resume after stop/crash.
 *
 * Reads structured loop-state entries (from appendEntry) for round info.
 * Reads assistant messages for overseer verdicts.
 */

import { extractText, isLoopStateEntry, loopStateRound } from "./session.js";
import { matchVerdict } from "./verdicts.js";

export interface ResumePoint {
	focus: string;
	round: number;
	phase: "overseer" | "workhorse";
	lastOverseerText: string;
	overseerLeafId: string | null;
}

export function reconstructState(ctx: any): ResumePoint | null {
	const entries = ctx.sessionManager.getEntries();

	// Scan backwards; stop at the loop-anchor boundary.
	let stateRound = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === "loop-anchor") break;

		// Structured state emitted after each workhorse round.
		if (isLoopStateEntry(e)) {
			return {
				focus: "all recent code changes",
				round: loopStateRound(e) + 1,
				phase: "overseer",
				lastOverseerText: "",
				overseerLeafId: null,
			};
		}

		// Overseer verdict.
		if (e.type === "message" && e.message?.role === "assistant") {
			const text = extractText(e.message.content);
			const verdict = matchVerdict(text);
			if (verdict === "approved") return null;
			if (verdict === "changes_requested") {
				// Find the most recent loop-state before this verdict for round info.
				for (let j = i - 1; j >= 0; j--) {
					if (entries[j].type === "custom" && entries[j].customType === "loop-anchor") break;
					if (isLoopStateEntry(entries[j])) {
						stateRound = loopStateRound(entries[j]);
						break;
					}
				}
				return {
					focus: "all recent code changes",
					round: stateRound > 0 ? stateRound + 1 : 1,
					phase: "workhorse",
					lastOverseerText: text,
					overseerLeafId: e.id,
				};
			}
		}
	}

	return null;
}
