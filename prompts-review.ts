import { expandContextPaths } from "./context.js";
import { sanitize } from "./session.js";
import type { PromptSet, OverseerPromptParams } from "./types.js";

export const reviewPrompts: PromptSet = {
	buildOverseerPrompt: reviewOverseerPrompt,
	buildWorkhorsePrompt: reviewWorkhorsePrompt,
};

function reviewOverseerPrompt(p: OverseerPromptParams): string {
	if (p.round > 1 && p.reviewMode === "incremental") return reviewIncrementalPrompt(p.round, p.unchangedCommits ?? [], p.changedContextPaths ?? []);
	return reviewFullPrompt(p);
}

function reviewIncrementalPrompt(round: number, unchangedCommits: string[], changedPaths: string[]): string {
	const parts = [
		`Re-review round ${round}. The workhorse addressed your previous feedback (see the summary above).`,
		"Verify the fixes are correct by reading the changed files and running git commands.",
		"If the author disagreed with a point and explained why, accept it unless it's objectively wrong.",
		"Also check for any new issues introduced by the fixes.",
	];

	if (unchangedCommits.length > 0) {
		parts.push(
			"",
			"## ⚠️ Unchanged commits detected",
			"The following commits were NOT modified by the workhorse (their patch fingerprint is identical to before):",
			...unchangedCommits.map(s => `- **${s}**`),
			"",
			"This is a red flag — the workhorse likely lumped fixes into the wrong commit.",
			"If you tagged these commits with issues, the fixes were NOT applied there.",
			"Re-request fixes for each unchanged commit specifically.",
		);
	}

	const ctx = changedPaths.length > 0 ? expandContextPaths(changedPaths) : "";
	if (ctx) parts.push("", "## Updated context files", "The following @path files were modified by the workhorse since your last review:", ctx);

	parts.push(
		"",
		"End with exactly one of:",
		"VERDICT: APPROVED",
		"VERDICT: CHANGES_REQUESTED",
	);

	return parts.join("\n");
}

function reviewFullPrompt(p: OverseerPromptParams): string {
	const parts = [
		`You are a code overseer. Review the code changes in this repository.`,
		`Focus: ${p.focus}`,
		"",
		"Review the code by reading files and running git commands.",
		"Before giving a verdict, inspect all relevant recent commits and changed files for the requested scope.",
		"Do NOT stop after the first issue — keep checking until you are confident there are no other blocking issues in scope.",
		"If the request spans multiple commits, identify every commit that needs fixing, not just the latest one.",
		"RULES:",
		"- You are the OVERSEER. Do NOT modify, edit, or write any files.",
		"- Only use read and bash. Run git/grep/find/ls via bash.",
		"- Review only the requested target. Ignore unrelated files unless directly relevant.",
		"",
		"For each issue you find:",
		"1. **Commit** — the short SHA that introduced it (run `git log --oneline` to find it)",
		"2. **File and line** — exact location",
		"3. **What's wrong** — be specific, not vague",
		"4. **How to fix it** — concrete suggestion the author can act on immediately",
		"",
		"Separate blocking issues (must fix) from nitpicks (optional).",
		"",
		"End your review with exactly one of:",
		"VERDICT: APPROVED",
		"VERDICT: CHANGES_REQUESTED",
	];

	const ctx = expandContextPaths(p.contextPaths);
	if (ctx) parts.push(ctx);

	if (p.round > 1 && p.workhorseSummaries.length > 0) {
		parts.push(
			"",
			"## Previous rounds",
			"Below is the workhorse's SELF-REPORTED summary. Do NOT trust it. The workhorse may have missed things, introduced new bugs, or only partially fixed issues.",
			"",
			...p.workhorseSummaries,
			"",
			"## YOUR JOB THIS ROUND",
			"You MUST read the actual source files and run git commands before giving a verdict.",
			"A review with zero tool calls is a rubber-stamp — that is unacceptable.",
			"Do a full holistic review — don't limit yourself to prior feedback.",
		);
	}

	return parts.join("\n");
}

function reviewWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number, opts?: { rewriteHistory?: boolean }): string {
	const cleaned = sanitize(overseerText.replace(/VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/gi, "").trim());
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
		"FIXES_COMPLETE",
		expandContextPaths(contextPaths),
	);

	return parts.join("\n");
}
