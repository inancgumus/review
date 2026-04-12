import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptSets } from "../prompts.ts";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";

test("exec orchestrator prompt includes orchestrator role and drip-feed instruction", () => {
	const prompt = promptSets.exec.buildOverseerPrompt({
		focus: "implement the auth module",
		round: 1,
		reviewMode: "fresh",
		contextPaths: [],
		workhorseSummaries: [],
	});

	assert.match(prompt, /orchestrat/i, "mentions orchestrator role");
	assert.match(prompt, /implement the auth module/, "includes focus");
	assert.match(prompt, /one.*(step|part)/i, "instructs to drip-feed one step at a time");
	assert.ok(prompt.includes(V_APPROVED), "includes approved verdict marker");
	assert.ok(prompt.includes(V_CHANGES), "includes changes requested marker");
	assert.match(prompt, /do not.*(modify|edit|write)/i, "forbids file modifications");
});

test("exec orchestrator round 2 includes workhorse summaries", () => {
	const prompt = promptSets.exec.buildOverseerPrompt({
		focus: "implement auth",
		round: 2,
		reviewMode: "fresh",
		contextPaths: [],
		workhorseSummaries: ["[Workhorse Round 1] Created User struct in models/user.go"],
	});

	assert.match(prompt, /Created User struct/, "includes workhorse summary from previous round");
});

test("exec implementer prompt includes orchestrator instructions and FIXES_COMPLETE", () => {
	const prompt = promptSets.exec.buildWorkhorsePrompt(
		"Implement step 1: create the User struct in models/user.go\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
	);

	assert.match(prompt, /create the User struct/, "includes orchestrator's instructions");
	assert.ok(prompt.includes(V_FIXES_COMPLETE), "uses FIXES_COMPLETE marker");
	assert.ok(!prompt.includes(V_CHANGES), "strips verdict from orchestrator text");
	assert.match(prompt, /git commit/, "includes git commit instructions");
	assert.match(prompt, /ONLY.*single step/i, "restricts to single step");
	assert.match(prompt, /not.*subagent/i, "forbids subagents");
});

test("exec implementer prompt uses commit (not amend) for new work", () => {
	const prompt = promptSets.exec.buildWorkhorsePrompt("Implement the login endpoint", [], 1);

	assert.match(prompt, /git commit -m/, "uses regular commit with message");
});

test("review prompt set still works unchanged", () => {
	const prompt = promptSets.review.buildOverseerPrompt({
		focus: "check auth",
		round: 1,
		reviewMode: "fresh",
		contextPaths: [],
		workhorseSummaries: [],
	});

	assert.match(prompt, /code overseer/i, "uses code overseer role");
	assert.match(prompt, /check auth/, "includes focus");
	assert.ok(prompt.includes(V_APPROVED), "includes verdict markers");
});

test("incremental review round 2 includes unchanged commits warning", () => {
	const prompt = promptSets.review.buildOverseerPrompt({
		focus: "check auth",
		round: 2,
		reviewMode: "incremental",
		contextPaths: [],
		workhorseSummaries: [],
		unchangedCommits: ["Add auth module", "Add request handler"],
	});

	assert.match(prompt, /Add auth module/, "lists unchanged commit");
	assert.match(prompt, /Add request handler/, "lists second unchanged commit");
	assert.match(prompt, /red flag|unchanged|not modified/i, "warns about unchanged commits");
});

test("incremental review round 2 without unchanged commits has no warning", () => {
	const prompt = promptSets.review.buildOverseerPrompt({
		focus: "check auth",
		round: 2,
		reviewMode: "incremental",
		contextPaths: [],
		workhorseSummaries: [],
		unchangedCommits: [],
	});

	assert.doesNotMatch(prompt, /unchanged/i, "no warning when all commits changed");
});

test("incremental review round 2 includes changed context files", () => {
	const dir = mkdtempSync(join(tmpdir(), "prompt-ctx-"));
	try {
		const file = join(dir, "auth.go");
		writeFileSync(file, "func auth() { fixed }");

		const prompt = promptSets.review.buildOverseerPrompt({
			focus: "check auth",
			round: 2,
			reviewMode: "incremental",
			contextPaths: [],
			workhorseSummaries: [],
			unchangedCommits: [],
			changedContextPaths: [file],
		});

		assert.match(prompt, /Updated context files/i, "has context header");
		assert.match(prompt, /func auth/, "includes file contents");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("incremental review round 2 excludes context when no files changed", () => {
	const prompt = promptSets.review.buildOverseerPrompt({
		focus: "check auth",
		round: 2,
		reviewMode: "incremental",
		contextPaths: ["/tmp/test/auth.go"],
		workhorseSummaries: [],
		unchangedCommits: [],
		changedContextPaths: [],
	});

	assert.doesNotMatch(prompt, /Context files/i, "no context section when nothing changed");
});

test("fresh review round 2 does NOT include unchanged commits warning", () => {
	const prompt = promptSets.review.buildOverseerPrompt({
		focus: "check auth",
		round: 2,
		reviewMode: "fresh",
		contextPaths: [],
		workhorseSummaries: ["[Workhorse Round 1] Fixed auth"],
		unchangedCommits: ["Add auth module"],
	});

	assert.doesNotMatch(prompt, /unchanged.*commit/i, "fresh mode ignores unchanged commits");
});

test("review workhorse prompt set still works unchanged", () => {
	const prompt = promptSets.review.buildWorkhorsePrompt(
		"Fix the race condition\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
	);

	assert.match(prompt, /Overseer Feedback/, "uses overseer feedback heading");
	assert.match(prompt, /Fix the race condition/, "includes overseer text");
	assert.ok(prompt.includes(V_FIXES_COMPLETE), "uses FIXES_COMPLETE marker");
});
