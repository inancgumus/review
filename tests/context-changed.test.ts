import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotContextHashes, changedContextPaths } from "../context.ts";

// ── Helpers ─────────────────────────────────────────────

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "ctx-changed-"));
}

// ── snapshotContextHashes ───────────────────────────────

test("snapshotContextHashes: returns hash per file path", () => {
	const dir = makeTmpDir();
	try {
		const fileA = join(dir, "a.go");
		const fileB = join(dir, "b.go");
		writeFileSync(fileA, "func a() {}");
		writeFileSync(fileB, "func b() {}");

		const hashes = snapshotContextHashes([fileA, fileB]);
		assert.equal(hashes.size, 2);
		assert.ok(hashes.has(fileA));
		assert.ok(hashes.has(fileB));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshotContextHashes: same content produces same hash", () => {
	const dir = makeTmpDir();
	try {
		const file = join(dir, "a.go");
		writeFileSync(file, "func a() {}");

		const hash1 = snapshotContextHashes([file]).get(file);
		const hash2 = snapshotContextHashes([file]).get(file);
		assert.equal(hash1, hash2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshotContextHashes: different content produces different hash", () => {
	const dir = makeTmpDir();
	try {
		const file = join(dir, "a.go");
		writeFileSync(file, "func a() {}");
		const hash1 = snapshotContextHashes([file]).get(file);

		writeFileSync(file, "func a() { fixed }");
		const hash2 = snapshotContextHashes([file]).get(file);

		assert.notEqual(hash1, hash2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshotContextHashes: works with directories", () => {
	const dir = makeTmpDir();
	try {
		const sub = join(dir, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "a.go"), "func a() {}");
		writeFileSync(join(sub, "b.go"), "func b() {}");

		const hashes = snapshotContextHashes([sub]);
		assert.equal(hashes.size, 1);
		assert.ok(hashes.has(sub));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshotContextHashes: directory hash changes when a file inside changes", () => {
	const dir = makeTmpDir();
	try {
		const sub = join(dir, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "a.go"), "func a() {}");

		const hash1 = snapshotContextHashes([sub]).get(sub);

		writeFileSync(join(sub, "a.go"), "func a() { fixed }");
		const hash2 = snapshotContextHashes([sub]).get(sub);

		assert.notEqual(hash1, hash2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshotContextHashes: skips missing paths", () => {
	const hashes = snapshotContextHashes(["/nonexistent/path.go"]);
	assert.equal(hashes.size, 0);
});

// ── changedContextPaths ─────────────────────────────────

test("changedContextPaths: returns only modified files", () => {
	const dir = makeTmpDir();
	try {
		const fileA = join(dir, "a.go");
		const fileB = join(dir, "b.go");
		writeFileSync(fileA, "func a() {}");
		writeFileSync(fileB, "func b() {}");

		const before = snapshotContextHashes([fileA, fileB]);

		// Modify only fileA
		writeFileSync(fileA, "func a() { fixed }");

		const changed = changedContextPaths([fileA, fileB], before);
		assert.deepEqual(changed, [fileA]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("changedContextPaths: returns empty when nothing changed", () => {
	const dir = makeTmpDir();
	try {
		const file = join(dir, "a.go");
		writeFileSync(file, "func a() {}");

		const before = snapshotContextHashes([file]);
		const changed = changedContextPaths([file], before);
		assert.deepEqual(changed, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("changedContextPaths: returns all when all changed", () => {
	const dir = makeTmpDir();
	try {
		const fileA = join(dir, "a.go");
		const fileB = join(dir, "b.go");
		writeFileSync(fileA, "func a() {}");
		writeFileSync(fileB, "func b() {}");

		const before = snapshotContextHashes([fileA, fileB]);

		writeFileSync(fileA, "func a() { fixed }");
		writeFileSync(fileB, "func b() { fixed }");

		const changed = changedContextPaths([fileA, fileB], before);
		assert.equal(changed.length, 2);
		assert.ok(changed.includes(fileA));
		assert.ok(changed.includes(fileB));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("changedContextPaths: new file (not in before snapshot) counts as changed", () => {
	const dir = makeTmpDir();
	try {
		const fileA = join(dir, "a.go");
		writeFileSync(fileA, "func a() {}");

		const before = snapshotContextHashes([fileA]);

		// New file added after snapshot
		const fileB = join(dir, "b.go");
		writeFileSync(fileB, "func b() {}");

		const changed = changedContextPaths([fileA, fileB], before);
		assert.deepEqual(changed, [fileB]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
