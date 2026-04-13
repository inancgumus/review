import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
/** Strip C0/C1/DEL/zero-width/line separator chars. */
function sanitize(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
}
import type { LoopMode, ReviewMode } from "./types.js";

export interface OverseerPromptParams {
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

export interface PromptSet {
	buildOverseerPrompt(p: OverseerPromptParams): string;
	buildWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number, opts?: { rewriteHistory?: boolean }): string;
}
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "./verdicts.js";

const CHANGES_STRIP_RE = /VERDICT:\s*\*{0,2}CHANGES_REQUESTED\*{0,2}/gi;

// ── Context path helpers ────────────────────────────────

const MAX_FILE_SIZE = 200_000;
const MAX_DIR_DEPTH = 3;

function expandTilde(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function readFileContent(filePath: string): string | null {
	try {
		const resolved = expandTilde(filePath);
		const stat = fs.statSync(resolved);
		if (stat.isFile()) {
			if (stat.size > MAX_FILE_SIZE)
				return `[${filePath}: skipped, ${Math.round(stat.size / 1024)}KB > 50KB limit]`;
			return `### ${filePath}\n\`\`\`\n${fs.readFileSync(resolved, "utf-8")}\n\`\`\``;
		}
		if (stat.isDirectory()) return readDirContent(resolved, filePath, 0);
	} catch { /* skip */ }
	return null;
}

function readDirContent(dirPath: string, displayPath: string, depth: number): string {
	if (depth >= MAX_DIR_DEPTH) return `[${displayPath}: max depth reached]`;
	const parts: string[] = [];
	for (const entry of safeDirEntries(dirPath)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dirPath, entry.name);
		const display = path.join(displayPath, entry.name);
		const content = entry.isFile()
			? readFileContent(full)
			: entry.isDirectory()
				? readDirContent(full, display, depth + 1)
				: null;
		if (content) parts.push(content);
	}
	return parts.join("\n\n");
}

function safeDirEntries(dirPath: string): fs.Dirent[] {
	try { return fs.readdirSync(dirPath, { withFileTypes: true }); }
	catch { return []; }
}

/** Re-read @path files from disk. Called before each overseer/workhorse prompt. */
function expandContextPaths(paths: string[]): string {
	if (paths.length === 0) return "";
	const parts: string[] = [];
	for (const p of paths) {
		const content = readFileContent(p);
		if (content) parts.push(content);
	}
	return parts.length > 0 ? "\n\n## Context files\n\n" + parts.join("\n\n") : "";
}

/** Hash each @path's content. Returns Map<path, sha256>. */
export function snapshotContextHashes(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const p of paths) {
		const content = readFileContent(p);
		if (content) {
			map.set(p, createHash("sha256").update(content).digest("hex"));
		}
	}
	return map;
}

/** Return paths whose content hash differs from the before snapshot. */
export function changedContextPaths(paths: string[], before: Map<string, string>): string[] {
	const now = snapshotContextHashes(paths);
	const changed: string[] = [];
	for (const p of paths) {
		const nowHash = now.get(p);
		const beforeHash = before.get(p);
		if (nowHash && nowHash !== beforeHash) changed.push(p);
	}
	return changed;
}

// ── Review prompts ──────────────────────────────────────

const reviewPrompts: PromptSet = {
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

function reviewWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number, opts?: { rewriteHistory?: boolean }): string {
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

// ── Exec prompts ────────────────────────────────────────

const execPrompts: PromptSet = {
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
		"Wrap the next step in `<task>` tags. Only the content inside the tags is sent to the workhorse.",
		"Your verification notes and reasoning stay outside — the workhorse never sees them.",
		"",
		"End with exactly one of:",
		`${V_APPROVED}`,
		`${V_CHANGES}`,
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
		"- Do NOT mention future steps, the overall plan, or what comes next. The workhorse must not know the full plan.",
		"- Be specific and actionable. The workhorse should not have to guess.",
		"",
		"## CRITICAL: Use <task> tags",
		"Wrap the current step description in `<task>` tags. ONLY the content inside these tags is sent to the workhorse. Everything outside is stripped.",
		"",
		"Example:",
		"```",
		"I verified step 1 is complete. Tests pass. Moving to step 2.",
		"",
		"<task>",
		"Create `calc.go` with an Add function that takes two int args and returns their sum.",
		"Add a test in `calc_test.go` with table-driven cases for positive, negative, and zero inputs.",
		"</task>",
		"```",
		"",
		"Your notes, verification results, and reasoning stay outside the tags — the workhorse never sees them.",
		"",
		"VERIFICATION CHECKLIST (do this every round):",
		"- Read the files the workhorse changed. Do they match what was asked?",
		"- Run tests/build. Do they pass?",
		"- Check for missing pieces: error handling, edge cases, tests if required.",
		"- A verdict with zero tool calls is a rubber-stamp — that is unacceptable.",
		"",
		"If ALL steps in the plan are correctly implemented AND verified:",
		`${V_APPROVED}`,
		"",
		"If the workhorse needs to do work (implement next step or redo current):",
		`${V_CHANGES}`,
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

function extractTask(text: string): string {
	const match = text.match(/<task>([\s\S]*?)<\/task>/i);
	if (match) return match[1].trim();
	return text;
}

function execWorkhorsePrompt(overseerText: string, _contextPaths: string[], round: number): string {
	const cleaned = sanitize(extractTask(overseerText).replace(CHANGES_STRIP_RE, "").trim());
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
		`${V_FIXES_COMPLETE}`,
	].join("\n");
}

// ── Manual prompts ──────────────────────────────────────

const manualPrompts: PromptSet = {
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

// ── Prompt set registry ─────────────────────────────────

export const promptSets: Record<LoopMode, PromptSet> = {
	review: reviewPrompts,
	exec: execPrompts,
	manual: manualPrompts,
};


