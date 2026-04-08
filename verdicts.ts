import type { Verdict } from "./types.js";

// Handles: VERDICT: APPROVED, **VERDICT:** APPROVED, **Verdict:** **APPROVED**, etc.
const APPROVED_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}APPROVED\*{0,2}/i;
const CHANGES_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/i;
const FIXES_COMPLETE_RE = /FIXES_COMPLETE/i;

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
		.replace(/\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}(APPROVED|CHANGES_REQUESTED)\*{0,2}/gi, "")
		.replace(FIXES_COMPLETE_RE, "")
		.trim();
}
