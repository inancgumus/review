import type { Verdict } from "./types.js";

export const V_APPROVED = "VERDICT: APPROVED";
export const V_CHANGES = "VERDICT: CHANGES_REQUESTED";
export const V_FIXES_COMPLETE = "FIXES_COMPLETE";

// Match regexes — handle markdown bold variants models sometimes output
const APPROVED_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}APPROVED\*{0,2}/i;
const CHANGES_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/i;
const FIXES_COMPLETE_RE = /FIXES_COMPLETE/i;

// Strip regex — removes verdict/fixes markers (any bold variant) from text
export const VERDICT_STRIP_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}(APPROVED|CHANGES_REQUESTED)\*{0,2}/gi;
export const CHANGES_STRIP_RE = /VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/gi;

export function matchVerdict(text: string): Verdict {
	if (APPROVED_RE.test(text)) return "approved";
	if (CHANGES_RE.test(text)) return "changes_requested";
	return null;
}

export function hasFixesComplete(text: string): boolean {
	return FIXES_COMPLETE_RE.test(text);
}

export function stripVerdict(text: string): string {
	return text
		.replace(VERDICT_STRIP_RE, "")
		.replace(FIXES_COMPLETE_RE, "")
		.trim();
}
