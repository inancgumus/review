import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotPatchIds, detectUnchanged, extractTaggedSHAs } from "../fixup-audit.ts";

// ── Helpers ─────────────────────────────────────────────

interface Repo {
	cwd: string;
	root: string;
	authSha: string;
	handlerSha: string;
	loggerSha: string;
}

function setupRepo(): Repo {
	const cwd = mkdtempSync(join(tmpdir(), "fixup-audit-"));
	const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8" }).trim();

	run("git init");
	run("git config user.email test@test.com");
	run("git config user.name Test");
	run("git commit --allow-empty -m root");

	execSync("echo 'func auth() { /* bug */ }' > auth.go", { cwd });
	run("git add auth.go");
	run("git commit -m 'Add auth module'");

	execSync("echo 'func handler() { /* bug */ }' > handler.go", { cwd });
	run("git add handler.go");
	run("git commit -m 'Add request handler'");

	execSync("echo 'func logger() { /* bug */ }' > logger.go", { cwd });
	run("git add logger.go");
	run("git commit -m 'Add logger'");

	return {
		cwd,
		root: run("git rev-list --max-parents=0 HEAD"),
		authSha: run("git log --format=%h --grep='Add auth module'"),
		handlerSha: run("git log --format=%h --grep='Add request handler'"),
		loggerSha: run("git log --format=%h --grep='Add logger'"),
	};
}

function cleanup(cwd: string) {
	rmSync(cwd, { recursive: true, force: true });
}

// ── extractTaggedSHAs ───────────────────────────────────

test("extractTaggedSHAs: extracts SHAs near commit keyword", () => {
	const text = [
		"### Issue 1",
		"**Commit** — `61bc742` introduced FormatStatus without tests",
		"",
		"### Issue 2",
		"Commit `589014d` has wrong error handling",
	].join("\n");
	const shas = extractTaggedSHAs(text);
	assert.ok(shas.includes("61bc742"));
	assert.ok(shas.includes("589014d"));
	assert.equal(shas.length, 2);
});

test("extractTaggedSHAs: extracts SHAs from git log style output", () => {
	const text = [
		"61bc742 Add FormatStatus function",
		"589014d Fix error handling in cloud upload",
		"fe67f7c Map test results to BareAborted",
	].join("\n");
	const shas = extractTaggedSHAs(text);
	assert.ok(shas.includes("61bc742"));
	assert.ok(shas.includes("589014d"));
	assert.ok(shas.includes("fe67f7c"));
});

test("extractTaggedSHAs: extracts SHAs from --fixup references", () => {
	const text = "Use `git commit --fixup=abc1234` for the first and `--fixup=def5678` for the second.";
	const shas = extractTaggedSHAs(text);
	assert.ok(shas.includes("abc1234"));
	assert.ok(shas.includes("def5678"));
});

test("extractTaggedSHAs: deduplicates", () => {
	const text = "Commit `abc1234` has an issue. Fix commit abc1234 before merging.";
	const shas = extractTaggedSHAs(text);
	assert.equal(shas.filter(s => s === "abc1234").length, 1);
});

test("extractTaggedSHAs: returns empty for text without SHAs", () => {
	assert.equal(extractTaggedSHAs("Everything looks good.").length, 0);
});

test("extractTaggedSHAs: ignores short hex strings under 7 chars", () => {
	assert.equal(extractTaggedSHAs("Color #ff0000 and value 0xdead are not SHAs.").length, 0);
});

// ── snapshotPatchIds ────────────────────────────────────

test("snapshotPatchIds: returns subject→patchId map for commits in range", () => {
	const repo = setupRepo();
	try {
		const snap = snapshotPatchIds(repo.cwd, repo.root);
		assert.equal(snap.size, 3);
		assert.ok(snap.has("Add auth module"));
		assert.ok(snap.has("Add request handler"));
		assert.ok(snap.has("Add logger"));
		// patch-ids are 40-char hex strings
		for (const pid of snap.values()) {
			assert.match(pid, /^[0-9a-f]{40}$/);
		}
	} finally {
		cleanup(repo.cwd);
	}
});

// ── Control: honest workhorse ───────────────────────────

test("honest workhorse: all tagged commits change patch-id", () => {
	const repo = setupRepo();
	const run = (cmd: string) => execSync(cmd, { cwd: repo.cwd, encoding: "utf-8" }).trim();

	try {
		const before = snapshotPatchIds(repo.cwd, repo.root);

		// Honest: separate fixup per commit
		execSync("echo 'func auth() { fixed }' > auth.go", { cwd: repo.cwd });
		run("git add auth.go");
		run(`git commit --fixup=${repo.authSha}`);

		execSync("echo 'func handler() { fixed }' > handler.go", { cwd: repo.cwd });
		run("git add handler.go");
		run(`git commit --fixup=${repo.handlerSha}`);

		execSync("echo 'func logger() { fixed }' > logger.go", { cwd: repo.cwd });
		run("git add logger.go");
		run(`git commit --fixup=${repo.loggerSha}`);

		run(`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${repo.root}`);

		const after = snapshotPatchIds(repo.cwd, repo.root);

		const taggedSubjects = ["Add auth module", "Add request handler", "Add logger"];
		const unchanged = detectUnchanged(before, after, taggedSubjects);

		assert.deepEqual(unchanged, [], "all tagged commits should have changed");
	} finally {
		cleanup(repo.cwd);
	}
});

// ── Test: cheating workhorse ────────────────────────────

test("cheating workhorse: lumps all fixes into one commit, unchanged commits detected", () => {
	const repo = setupRepo();
	const run = (cmd: string) => execSync(cmd, { cwd: repo.cwd, encoding: "utf-8" }).trim();

	try {
		const before = snapshotPatchIds(repo.cwd, repo.root);

		// Cheat: fix all 3 files but shove everything into the logger commit
		execSync("echo 'func auth() { fixed }' > auth.go", { cwd: repo.cwd });
		execSync("echo 'func handler() { fixed }' > handler.go", { cwd: repo.cwd });
		execSync("echo 'func logger() { fixed }' > logger.go", { cwd: repo.cwd });
		run("git add -A");
		run(`git commit --fixup=${repo.loggerSha}`);

		run(`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${repo.root}`);

		const after = snapshotPatchIds(repo.cwd, repo.root);

		const taggedSubjects = ["Add auth module", "Add request handler", "Add logger"];
		const unchanged = detectUnchanged(before, after, taggedSubjects);

		// Auth and handler were NOT properly fixed in their own commits
		assert.ok(unchanged.includes("Add auth module"), "auth commit should be detected as unchanged");
		assert.ok(unchanged.includes("Add request handler"), "handler commit should be detected as unchanged");
		assert.ok(!unchanged.includes("Add logger"), "logger commit should show as changed");
		assert.equal(unchanged.length, 2);
	} finally {
		cleanup(repo.cwd);
	}
});

// ── Edge: partial fix (overseer only tagged 2 of 3) ────

test("partial fix: only tagged commits are checked", () => {
	const repo = setupRepo();
	const run = (cmd: string) => execSync(cmd, { cwd: repo.cwd, encoding: "utf-8" }).trim();

	try {
		const before = snapshotPatchIds(repo.cwd, repo.root);

		// Honestly fix only auth and handler (logger not tagged by overseer)
		execSync("echo 'func auth() { fixed }' > auth.go", { cwd: repo.cwd });
		run("git add auth.go");
		run(`git commit --fixup=${repo.authSha}`);

		execSync("echo 'func handler() { fixed }' > handler.go", { cwd: repo.cwd });
		run("git add handler.go");
		run(`git commit --fixup=${repo.handlerSha}`);

		run(`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash ${repo.root}`);

		const after = snapshotPatchIds(repo.cwd, repo.root);

		// Only check auth and handler — logger was not tagged
		const taggedSubjects = ["Add auth module", "Add request handler"];
		const unchanged = detectUnchanged(before, after, taggedSubjects);

		assert.deepEqual(unchanged, [], "both tagged commits should have changed");
	} finally {
		cleanup(repo.cwd);
	}
});

// ── Edge: single commit tagged → no audit needed ───────

test("single tagged commit: detectUnchanged still works", () => {
	const repo = setupRepo();
	const run = (cmd: string) => execSync(cmd, { cwd: repo.cwd, encoding: "utf-8" }).trim();

	try {
		const before = snapshotPatchIds(repo.cwd, repo.root);

		execSync("echo 'func auth() { fixed }' > auth.go", { cwd: repo.cwd });
		run("git add -A");
		run(`git commit --amend --no-edit`);

		const after = snapshotPatchIds(repo.cwd, repo.root);

		// Only 1 tagged commit — caller would skip audit, but detectUnchanged still works
		const unchanged = detectUnchanged(before, after, ["Add logger"]);
		// Logger wasn't modified (only auth was amended, but that was the latest commit here... 
		// actually auth is first commit, amend changes it)
		// The amend changed "Add logger" commit since it's HEAD
		assert.equal(unchanged.length, 0);
	} finally {
		cleanup(repo.cwd);
	}
});
