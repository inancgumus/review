import { expandContextPaths } from "./context.js";
import { sanitize } from "./session.js";
import type { PromptSet, OverseerPromptParams } from "./types.js";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, CHANGES_STRIP_RE } from "./verdicts.js";

export const manualPrompts: PromptSet = {
	buildOverseerPrompt: manualOverseerPrompt,
	buildWorkhorsePrompt: manualWorkhorsePrompt,
};

function manualOverseerPrompt(p: OverseerPromptParams): string {
	const feedback = p.userFeedback || p.focus;
	const sha = p.commitSha || "unknown";

	if (p.round > 1) {
		return [
			`Re-verify round ${p.round}. The workhorse attempted fixes again.`,
			"Check if your previous concerns were addressed.",
			"",
			`The user reviewed commit ${sha} and gave this feedback:`,
			feedback,
			"",
			"Do NOT add your own issues. Do NOT review beyond the user's feedback.",
			"",
			"End with exactly one of:",
			`${V_APPROVED}`,
			`${V_CHANGES}`,
		].join("\n");
	}

	return [
		"You are verifying that the workhorse correctly addressed the user's feedback.",
		"",
		`The user reviewed commit ${sha} and gave this feedback:`,
		feedback,
		"",
		"Your ONLY job: did the workhorse do what the user asked? Check each point.",
		"Do NOT add your own issues. Do NOT review beyond the user's feedback.",
		"Read the files, run git commands, verify each point was addressed.",
		"",
		"End with exactly one of:",
		`${V_APPROVED}`,
		`${V_CHANGES}`,
	].join("\n");
}

function manualWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number): string {
	let sha = "";
	let feedbackText = overseerText;
	const commitMatch = overseerText.match(/^\[COMMIT:([^\]]+)\]\n?/);
	if (commitMatch) {
		sha = commitMatch[1];
		feedbackText = overseerText.slice(commitMatch[0].length);
	}

	const cleaned = sanitize(feedbackText.replace(CHANGES_STRIP_RE, "").trim());

	const parts = [
		`## Fix Issues — Round ${round}`,
		"",
	];

	if (sha) {
		parts.push(`Fix the issues on commit ${sha} described below.`);
	} else {
		parts.push("Fix the issues described below.");
	}

	parts.push(
		"",
		cleaned,
		"",
		"---",
		"",
		"Address every issue listed above.",
		"",
		"### Git rules (mandatory)",
	);

	if (sha) {
		parts.push(
			`The commit under review is \`${sha}\`.`,
			`1. Read it with \`git show ${sha}\``,
			"2. Fix the issues",
			`3. If the commit is HEAD: \`git add -A && git commit --amend --no-edit\``,
			"4. If not HEAD:",
			`   - Stage only the affected files: \`git add <files>\``,
			`   - Create a fixup commit: \`git commit --fixup=${sha}\``,
			`   - Autosquash rebase: \`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${sha}~1\``,
		);
	} else {
		parts.push(
			"The commit under review is referenced in the feedback above.",
			"- If the commit is HEAD: `git add -A && git commit --amend --no-edit`",
			"- If not HEAD: `git add <files> && git commit --fixup=<sha>` then `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <sha>~1`",
		);
	}

	parts.push(
		"",
		"### CRITICAL: Never open an interactive editor",
		"- ALWAYS prefix `git rebase -i` with `GIT_SEQUENCE_EDITOR=true` (to auto-accept) or `GIT_SEQUENCE_EDITOR=\"sed ...\"` (to script edits).",
		"- NEVER run bare `git rebase -i` — it opens vim/vi and you WILL get stuck.",
		"- Same applies to `git commit` without `-m` or `--no-edit` — always pass a message flag.",
		"",
		"IMPORTANT: Do NOT output any VERDICT lines. You are the workhorse, not the overseer.",
		"",
		"When you have addressed ALL issues (fixed or explained why you disagree),",
		"end your response with exactly:",
		`${V_FIXES_COMPLETE}`,
		expandContextPaths(contextPaths),
	);

	return parts.join("\n");
}
