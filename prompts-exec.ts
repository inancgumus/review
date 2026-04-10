import { expandContextPaths } from "./context.js";
import { sanitize } from "./session.js";
import type { PromptSet, OverseerPromptParams } from "./types.js";

export const execPrompts: PromptSet = {
	buildOverseerPrompt: execOverseerPrompt,
	buildWorkhorsePrompt: execWorkhorsePrompt,
};

function execOverseerPrompt(p: OverseerPromptParams): string {
	if (p.round > 1 && p.reviewMode === "incremental") return execIncrementalPrompt(p.round);
	return execFullPrompt(p);
}

function execIncrementalPrompt(round: number): string {
	return [
		`Re-check round ${round}. The workhorse worked on the step you assigned (see the summary above).`,
		"Do NOT trust the summary. Read the actual files. Run tests. Run the build. Verify with your own eyes.",
		"",
		"If the step is done correctly AND tests/build pass, assign the next step.",
		"If anything is missing, wrong, or broken, reassign the same step with specific feedback.",
		"If ALL steps in the plan are complete and verified, approve.",
		"A verdict with zero tool calls is a rubber-stamp — that is unacceptable.",
		"",
		"End with exactly one of:",
		"VERDICT: APPROVED",
		"VERDICT: CHANGES_REQUESTED",
	].join("\n");
}

function execFullPrompt(p: OverseerPromptParams): string {
	const parts = [
		"You are an implementation orchestrator. You oversee a plan and direct a workhorse to build it step by step.",
		`Focus: ${p.focus}`,
		"",
		"Read the plan and context files below. Examine the current state of the codebase by reading files and running commands.",
		"",
		"YOUR JOB:",
		"1. VERIFY what has been implemented so far. Read the actual source files. Run tests. Run the build. Check git log. Do NOT skip verification.",
		"2. If the workhorse just attempted a step: read every file they claimed to change. Run tests. If anything is missing, wrong, or broken — reassign the same step with specific feedback on what failed.",
		"3. Only after verifying the current step is FULLY correct, identify the next unimplemented step.",
		"4. Describe EXACTLY what the workhorse should do for this ONE step — file paths, function signatures, behavior, tests.",
		"",
		"RULES:",
		"- You are the ORCHESTRATOR. Do NOT modify, edit, or write any files.",
		"- Only use read and bash. Run git/grep/find/ls/tests via bash.",
		"- Drip-feed ONE step at a time. Never dump multiple steps.",
		"- Your output goes directly to the workhorse. ONLY describe the current step.",
		"- Do NOT mention future steps, the overall plan, or what comes next. The workhorse must not know the full plan.",
		"- Be specific and actionable. The workhorse should not have to guess.",
		"",
		"VERIFICATION CHECKLIST (do this every round):",
		"- Read the files the workhorse changed. Do they match what was asked?",
		"- Run tests/build. Do they pass?",
		"- Check for missing pieces: error handling, edge cases, tests if required.",
		"- A verdict with zero tool calls is a rubber-stamp — that is unacceptable.",
		"",
		"If ALL steps in the plan are correctly implemented AND verified:",
		"VERDICT: APPROVED",
		"",
		"If the workhorse needs to do work (implement next step or redo current):",
		"VERDICT: CHANGES_REQUESTED",
	];

	const ctx = expandContextPaths(p.contextPaths);
	if (ctx) parts.push(ctx);

	if (p.round > 1 && p.workhorseSummaries.length > 0) {
		parts.push(
			"",
			"## Previous rounds",
			"Below is the workhorse's SELF-REPORTED summary. Do NOT trust it. Verify by reading the actual code.",
			"",
			...p.workhorseSummaries,
			"",
			"## YOUR JOB THIS ROUND",
			"You MUST read the actual source files and run tests/build before giving a verdict.",
			"Do NOT trust the summary above. The workhorse may have cut corners, skipped tests, or left broken code.",
			"Verify the last step was implemented correctly, then assign the next step or approve.",
		);
	}

	return parts.join("\n");
}

function execWorkhorsePrompt(overseerText: string, _contextPaths: string[], round: number): string {
	const cleaned = sanitize(overseerText.replace(/VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/gi, "").trim());
	return [
		`## Workhorse Task — Round ${round}`,
		"",
		cleaned,
		"",
		"---",
		"",
		"Implement ONLY the single step the orchestrator described above — nothing more.",
		"- Do NOT implement ahead. Do NOT look at or work on future steps.",
		"- Do NOT delegate to subagents. Do all the work yourself, directly.",
		"- Follow the instructions precisely.",
		"- Run tests if the orchestrator asked you to, or if the project has them.",
		"- When done, stop. The orchestrator will assign the next step.",
		"",
		"### Git rules (mandatory)",
		"- Commit your work: `git add -A && git commit -m \"<descriptive message>\"`",
		"- Use clear, descriptive commit messages that explain what the commit does.",
		"- One commit per step unless the orchestrator says otherwise.",
		"",
		"### CRITICAL: Never open an interactive editor",
		"- NEVER run bare `git rebase -i` — it opens vim/vi and you WILL get stuck.",
		"- Same applies to `git commit` without `-m` or `--no-edit` — always pass a message flag.",
		"",
		"IMPORTANT: Do NOT output any VERDICT lines. You are the workhorse, not the orchestrator.",
		"",
		"When you have completed the work,",
		"end your response with exactly:",
		"FIXES_COMPLETE",
	].join("\n");
}
