import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	resolveRange,
	getCommitList,
	getCommitDiff,
	buildPatchIdMap,
	remapAfterRebase,
} from "../git-manual.ts";

// ── Helpers ─────────────────────────────────────────────

function makeRepo(): { cwd: string; root: string } {
	const cwd = mkdtempSync(join(tmpdir(), "git-manual-"));
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	run("git init -b main");
	run("git config user.email test@test.com");
	run("git config user.name Test");
	run("git commit --allow-empty -m root");
	const root = run("git rev-parse HEAD");
	return { cwd, root };
}

function cleanup(cwd: string) {
	rmSync(cwd, { recursive: true, force: true });
}

// ── resolveRange ────────────────────────────────────────

test("resolveRange: returns explicit range as-is", () => {
	const { cwd } = makeRepo();
	try {
		assert.equal(resolveRange(cwd, "HEAD~5..HEAD"), "HEAD~5..HEAD");
		assert.equal(resolveRange(cwd, "abc123..def456"), "abc123..def456");
	} finally {
		cleanup(cwd);
	}
});

test("resolveRange: detects merge-base from main", () => {
	const { cwd, root } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		run("git checkout -b feature");
		execSync("echo 'a' > a.txt", { cwd });
		run("git add a.txt");
		run("git commit -m 'commit on feature'");

		const result = resolveRange(cwd, "");
		assert.equal(result, `${root}..HEAD`);
	} finally {
		cleanup(cwd);
	}
});

// ── getCommitList ───────────────────────────────────────

test("getCommitList: returns SHAs in order", () => {
	const { cwd, root } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		execSync("echo 'a' > a.txt", { cwd });
		run("git add a.txt");
		run("git commit -m A");
		const shaA = run("git rev-parse HEAD");

		execSync("echo 'b' > b.txt", { cwd });
		run("git add b.txt");
		run("git commit -m B");
		const shaB = run("git rev-parse HEAD");

		const list = getCommitList(cwd, `${root}..HEAD`);
		assert.deepEqual(list, [shaA, shaB]);
	} finally {
		cleanup(cwd);
	}
});

test("getCommitList: returns empty for no commits in range", () => {
	const { cwd } = makeRepo();
	try {
		assert.deepEqual(getCommitList(cwd, "HEAD..HEAD"), []);
	} finally {
		cleanup(cwd);
	}
});

// ── getCommitDiff ───────────────────────────────────────

test("getCommitDiff: returns diff content", () => {
	const { cwd } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		execSync("echo 'hello world' > hello.txt", { cwd });
		run("git add hello.txt");
		run("git commit -m 'add hello'");
		const sha = run("git rev-parse HEAD");

		const diff = getCommitDiff(cwd, sha);
		assert.ok(diff.includes("hello.txt"), "should contain filename");
		assert.ok(diff.includes("hello world"), "should contain file content");
		assert.ok(diff.includes("add hello"), "should contain commit message");
	} finally {
		cleanup(cwd);
	}
});

// ── buildPatchIdMap ─────────────────────────────────────

test("buildPatchIdMap: maps patchIds to SHAs", () => {
	const { cwd, root } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		execSync("echo 'a' > a.txt", { cwd });
		run("git add a.txt");
		run("git commit -m A");
		const shaA = run("git rev-parse HEAD");

		execSync("echo 'b' > b.txt", { cwd });
		run("git add b.txt");
		run("git commit -m B");
		const shaB = run("git rev-parse HEAD");

		const map = buildPatchIdMap(cwd, [shaA, shaB]);
		assert.equal(map.size, 2);

		const values = [...map.values()];
		assert.ok(values.includes(shaA));
		assert.ok(values.includes(shaB));

		for (const pid of map.keys()) {
			assert.match(pid, /^[0-9a-f]{40}$/);
		}
	} finally {
		cleanup(cwd);
	}
});

// ── remapAfterRebase ────────────────────────────────────

test("remapAfterRebase: tracks SHA changes after amend", () => {
	const { cwd, root } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		execSync("echo 'a' > a.txt", { cwd });
		run("git add a.txt");
		run("git commit -m A");

		execSync("echo 'b' > b.txt", { cwd });
		run("git add b.txt");
		run("git commit -m B");

		const range = `${root}..HEAD`;
		const oldList = getCommitList(cwd, range);
		const oldMap = buildPatchIdMap(cwd, oldList);
		const oldShaB = oldList[1];

		// Amend message only — patch-id stays same, SHA changes
		run("git commit --amend -m 'B amended'");

		const result = remapAfterRebase(cwd, range, oldMap);

		assert.ok(result.remap.has(oldShaB), "old SHA should be remapped");
		assert.notEqual(result.remap.get(oldShaB), oldShaB, "new SHA should differ");
		assert.equal(result.lost.length, 0, "no commits should be lost");
		assert.equal(result.newList.length, 2);
	} finally {
		cleanup(cwd);
	}
});

test("remapAfterRebase: detects lost commits after squash", () => {
	const { cwd, root } = makeRepo();
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	try {
		execSync("echo 'a' > a.txt", { cwd });
		run("git add a.txt");
		run("git commit -m A");

		execSync("echo 'b' > b.txt", { cwd });
		run("git add b.txt");
		run("git commit -m B");

		execSync("echo 'c' > c.txt", { cwd });
		run("git add c.txt");
		run("git commit -m C");

		const range = `${root}..HEAD`;
		const oldList = getCommitList(cwd, range);
		assert.equal(oldList.length, 3);
		const oldMap = buildPatchIdMap(cwd, oldList);

		// Squash B+C into one: reset to A, recommit staged B+C changes
		run("git reset --soft HEAD~2");
		run("git commit -m 'BC squashed'");

		const result = remapAfterRebase(cwd, range, oldMap);

		assert.ok(result.lost.length >= 2, "B and C patch-ids should be lost");
		assert.equal(result.newList.length, 2, "should have A + squashed");
	} finally {
		cleanup(cwd);
	}
});
