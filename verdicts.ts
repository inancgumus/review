/** Protocol constants for agent communication. */
export const V_APPROVED = "VERDICT: APPROVED";
export const V_CHANGES = "VERDICT: CHANGES_REQUESTED";
export const V_FIXES_COMPLETE = "FIXES_COMPLETE";

// ── Verdict parsing ─────────────────────────────────────

const APPROVED_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}APPROVED\*{0,2}/i;
const CHANGES_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/i;
const FIXES_COMPLETE_RE = /FIXES_COMPLETE/i;
const VERDICT_STRIP_RE = /\*{0,2}VERDICT:?\*{0,2}\s*\*{0,2}(APPROVED|CHANGES_REQUESTED)\*{0,2}/gi;

export const CHANGES_STRIP_RE = /VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/gi;

export function matchVerdict(text: string): "approved" | "changes_requested" | null {
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

/** Strip C0/C1/DEL/zero-width/line separator chars. */
export function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
}
