import assert from "node:assert/strict";
import test from "node:test";
import { promptSets } from "../prompts.ts";

test("review workhorse prompt excludes fixup/amend/rebase rules by default", () => {
	const prompt = promptSets.review.buildWorkhorsePrompt(
		"Fix the bug in auth.go\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
	);

	assert.doesNotMatch(prompt, /--fixup/, "no fixup instructions");
	assert.doesNotMatch(prompt, /--amend/, "no amend instructions");
	assert.doesNotMatch(prompt, /autosquash/, "no autosquash rebase");
});

test("review workhorse prompt includes fixup/amend/rebase rules when rewriteHistory is true", () => {
	const prompt = promptSets.review.buildWorkhorsePrompt(
		"Fix the bug in auth.go\nVERDICT: CHANGES_REQUESTED",
		[],
		1,
		{ rewriteHistory: true },
	);

	assert.match(prompt, /--fixup/, "includes fixup instructions");
	assert.match(prompt, /--amend/, "includes amend instructions");
	assert.match(prompt, /autosquash/, "includes autosquash rebase");
});

test("review workhorse prompt always includes FIXES_COMPLETE regardless of rewriteHistory", () => {
	const off = promptSets.review.buildWorkhorsePrompt("Fix it\nVERDICT: CHANGES_REQUESTED", [], 1);
	const on = promptSets.review.buildWorkhorsePrompt("Fix it\nVERDICT: CHANGES_REQUESTED", [], 1, { rewriteHistory: true });

	assert.match(off, /FIXES_COMPLETE/, "present when off");
	assert.match(on, /FIXES_COMPLETE/, "present when on");
});
