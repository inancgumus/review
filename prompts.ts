import type { ReviewMode } from "./types.js";

interface OverseerPromptParams {
	focus: string;
	round: number;
	reviewMode: ReviewMode;
	contextPaths: string[];
	workhorseSummaries: string[];
	unchangedCommits: string[];
	changedContextPaths: string[];
	userFeedback?: string;
	commitSha?: string;
}

interface PromptSet {
	buildOverseerPrompt(p: OverseerPromptParams): string;
	buildWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number, opts?: { rewriteHistory?: boolean }): string;
}
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "./verdicts.js";
import { expandContextPaths } from "./context.js";
import { buildReviewWorkhorsePrompt } from "./review-workhorse.js";



// ── Review prompts ──────────────────────────────────────

const reviewPrompts: PromptSet = {
	buildOverseerPrompt: reviewOverseerPrompt,
	buildWorkhorsePrompt: buildReviewWorkhorsePrompt,
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
		`${V_APPROVED}`,
		`${V_CHANGES}`,
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
		`${V_APPROVED}`,
		`${V_CHANGES}`,
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

// ── Prompt set registry ─────────────────────────────────

export const promptSets: Record<string, PromptSet> = {
	review: reviewPrompts,
};
