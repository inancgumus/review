import assert from "node:assert/strict";
import test from "node:test";
import { promptSets } from "../prompts.ts";

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
	assert.match(prompt, /VERDICT: APPROVED/, "includes approved verdict marker");
	assert.match(prompt, /VERDICT: CHANGES_REQUESTED/, "includes changes requested marker");
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
	assert.match(prompt, /FIXES_COMPLETE/, "uses FIXES_COMPLETE marker");
	assert.doesNotMatch(prompt, /VERDICT: CHANGES_REQUESTED/, "strips verdict from orchestrator text");
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
	assert.match(prompt, /VERDICT: APPROVED/, "includes verdict markers");
});

test("review workhorse prompt set still works unchanged", () => {
	const prompt = promptSets.review.buildWorkhorsePrompt(
		"Fix the race condition\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
	);

	assert.match(prompt, /Overseer Feedback/, "uses overseer feedback heading");
	assert.match(prompt, /Fix the race condition/, "includes overseer text");
	assert.match(prompt, /FIXES_COMPLETE/, "uses FIXES_COMPLETE marker");
});
