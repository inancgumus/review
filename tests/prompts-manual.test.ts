import assert from "node:assert/strict";
import test from "node:test";
import { promptSets } from "../prompts.ts";

const baseParams = {
	focus: "check auth",
	round: 1,
	reviewMode: "fresh" as const,
	contextPaths: [],
	workhorseSummaries: [],
	unchangedCommits: [],
	changedContextPaths: [],
	userFeedback: "The error handling is missing in login()",
	commitSha: "abc1234",
};

test("manual overseer prompt mentions verify and includes user feedback", () => {
	const prompt = promptSets.manual.buildOverseerPrompt(baseParams);

	assert.match(prompt, /verify/i, "mentions verify");
	assert.match(prompt, /error handling is missing/, "includes user feedback");
});

test("manual overseer prompt includes commit SHA", () => {
	const prompt = promptSets.manual.buildOverseerPrompt(baseParams);

	assert.match(prompt, /abc1234/, "includes commit SHA");
});

test("manual overseer prompt does NOT mention code overseer or orchestrator", () => {
	const prompt = promptSets.manual.buildOverseerPrompt(baseParams);

	assert.doesNotMatch(prompt, /code overseer/i, "does not mention code overseer");
	assert.doesNotMatch(prompt, /orchestrator/i, "does not mention orchestrator");
});

test("manual overseer prompt says not to add own issues", () => {
	const prompt = promptSets.manual.buildOverseerPrompt(baseParams);

	assert.match(prompt, /not.*add.*own issues/i, "says not to add own issues");
});

test("manual overseer round 2 is shorter re-verify prompt", () => {
	const round1 = promptSets.manual.buildOverseerPrompt(baseParams);
	const round2 = promptSets.manual.buildOverseerPrompt({ ...baseParams, round: 2 });

	assert.match(round2, /re-verify/i, "round 2 mentions re-verify");
	assert.ok(round2.length < round1.length, "round 2 is shorter than round 1");
	assert.match(round2, /abc1234/, "round 2 still includes SHA for reference");
	assert.match(round2, /error handling is missing/, "round 2 still includes user feedback");
});

test("manual overseer falls back to focus when userFeedback is undefined", () => {
	const prompt = promptSets.manual.buildOverseerPrompt({
		...baseParams,
		userFeedback: undefined,
		commitSha: undefined,
	});

	assert.match(prompt, /check auth/, "falls back to focus text");
	assert.match(prompt, /unknown/, "falls back to unknown SHA");
});

test("manual workhorse prompt includes FIXES_COMPLETE", () => {
	const prompt = promptSets.manual.buildWorkhorsePrompt(
		"[COMMIT:abc1234]\nFix the error handling",
		[],
		1,
	);

	assert.match(prompt, /FIXES_COMPLETE/, "includes FIXES_COMPLETE");
});

test("manual workhorse prompt includes fixup/amend git rules", () => {
	const prompt = promptSets.manual.buildWorkhorsePrompt(
		"[COMMIT:abc1234]\nFix the error handling",
		[],
		1,
	);

	assert.match(prompt, /--fixup=abc1234/, "includes fixup with SHA");
	assert.match(prompt, /--amend/, "includes amend rule");
	assert.match(prompt, /git show abc1234/, "includes git show with SHA");
});

test("manual workhorse prompt strips VERDICT from input", () => {
	const prompt = promptSets.manual.buildWorkhorsePrompt(
		"[COMMIT:abc1234]\nFix the bug\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
	);

	assert.doesNotMatch(prompt, /VERDICT: CHANGES_REQUESTED/, "strips verdict");
	assert.match(prompt, /Fix the bug/, "keeps the actual feedback");
});

test("manual workhorse prompt without COMMIT prefix uses generic rules", () => {
	const prompt = promptSets.manual.buildWorkhorsePrompt(
		"Fix the bug in commit def5678",
		[],
		1,
	);

	assert.match(prompt, /referenced in the feedback above/, "uses generic SHA reference");
	assert.match(prompt, /FIXES_COMPLETE/, "still includes FIXES_COMPLETE");
});

test("promptSets.manual exists and works", () => {
	assert.ok(promptSets.manual, "manual prompt set exists");
	assert.equal(typeof promptSets.manual.buildOverseerPrompt, "function", "has buildOverseerPrompt");
	assert.equal(typeof promptSets.manual.buildWorkhorsePrompt, "function", "has buildWorkhorsePrompt");
});
