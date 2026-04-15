/**
 * Review workhorse — shared fix prompt and state reconstruction for /loop:resume.
 * Used by review-fresh (and future review-incremental).
 */

import { V_FIXES_COMPLETE, sanitize, CHANGES_STRIP_RE } from "./verdicts.js";
import { expandContextPaths } from "./context.js";
import { extractText } from "./session.js";
import { matchVerdict } from "./verdicts.js";

// ── Workhorse fix prompt ────────────────────────────────

export function buildReviewWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number, opts?: { rewriteHistory?: boolean }): string {
	const cleaned = sanitize(overseerText.replace(CHANGES_STRIP_RE, "").trim());
	const rewrite = opts?.rewriteHistory === true;
	const parts = [
		`## Overseer Feedback — Round ${round}`,
		"",
		cleaned,
		"",
		"---",
		"",
		"Address every blocking issue listed above:",
		"- **Fix it**, or **explain why you disagree** (the overseer will accept reasonable justifications).",
		"- Nitpicks are optional — fix them if you agree, skip if you don't.",
	];

	if (rewrite) {
		parts.push(
			"",
			"### Git rules (mandatory)",
			"- If changes are **uncommitted** (unstaged/staged): leave them uncommitted. Do not commit.",
			"- If changes span **a single commit**: `git add -A && git commit --amend --no-edit`",
			"- If changes span **multiple commits** (the overseer tagged issues with commit SHAs):",
			"  1. Fix each issue, then stage ONLY its files: `git add <files>`",
			"  2. Create a fixup commit targeting the right SHA: `git commit --fixup=<sha>`",
			"  3. **YOU MUST** run the autosquash rebase after ALL fixup commits are created:",
			"     ```bash",
			"     GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <parent-of-oldest-fixed-commit>",
			"     ```",
			"     This is NOT optional. If you skip it, the fixups remain as separate commits.",
			"  If the rebase has conflicts, resolve them and `git rebase --continue`.",
			"- If the overseer asked to **split a commit**:",
			"  1. `GIT_SEQUENCE_EDITOR=\"sed -i '' 's/^pick \\(<sha>\\)/edit \\1/'\" git rebase -i <parent>`",
			"  2. `git reset HEAD~` to unstage everything",
			"  3. Selectively `git add` and `git commit` each logical piece",
			"  4. `git rebase --continue`",
			"  Do NOT ask for confirmation. Execute the split immediately.",
			"- **Never create new standalone commits** unless splitting. Only --amend or --fixup.",
			"",
			"### CRITICAL: Never open an interactive editor",
			"- ALWAYS prefix `git rebase -i` with `GIT_SEQUENCE_EDITOR=true` (to auto-accept) or `GIT_SEQUENCE_EDITOR=\"sed ...\"` (to script edits).",
			"- NEVER run bare `git rebase -i` — it opens vim/vi and you WILL get stuck.",
			"- Same applies to `git commit` without `-m` or `--no-edit` — always pass a message flag.",
		);
	}

	parts.push(
		"",
		"IMPORTANT: Do NOT output any VERDICT lines. You are the workhorse, not the overseer.",
		"",
		"When you have addressed ALL blocking issues (fixed or explained why you disagree),",
		"end your response with exactly:",
		`${V_FIXES_COMPLETE}`,
		expandContextPaths(contextPaths),
	);

	return parts.join("\n");
}

// ── State reconstruction for /loop:resume ───────────────

export interface RecoveredState {
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
