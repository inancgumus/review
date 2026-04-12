import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const opts = (cwd: string) => ({ cwd, encoding: "utf-8" as const, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] as const });

/**
 * Resolve the git toplevel. Tries cwd, process.cwd(), then extracts
 * the project path from the first user message (pi passes the opened dir as the first message).
 */
export function gitToplevel(cwd: string, sessionEntries?: any[]): string {
	for (const dir of [cwd, process.cwd()]) {
		try { return execSync("git rev-parse --show-toplevel", opts(dir)).trim(); }
		catch { /* not a git repo */ }
	}
	if (sessionEntries) {
		for (const e of sessionEntries) {
			if (e.type !== "message" || e.message?.role !== "user") continue;
			const content = e.message.content;
			const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((c: any) => c.type === "text")?.text : null;
			if (!text) continue;
			const candidate = text.trim();
			if (candidate.startsWith("/") && existsSync(candidate)) {
				try { return execSync("git rev-parse --show-toplevel", opts(candidate)).trim(); }
				catch { /* not a git repo */ }
			}
			break; // only check first user message
		}
	}
	return cwd;
}

/**
 * If rangeArg is non-empty, return it as-is.
 * Otherwise detect merge-base with main (fallback master) and return `<base>..HEAD`.
 */
export function resolveRange(cwd: string, rangeArg: string): string {
	if (rangeArg) return rangeArg;

	const head = execSync("git rev-parse HEAD", opts(cwd)).trim();

	for (const branch of ["main", "master"]) {
		try {
			const base = execSync(`git merge-base HEAD ${branch}`, opts(cwd)).trim();
			if (base !== head) return `${base}..HEAD`;
			// On the target branch itself — fall through to root detection
		} catch {
			// branch not found
		}
	}

	// On main/master or no remote branch: use root commit as base
	try {
		const root = execSync("git rev-list --max-parents=0 HEAD", opts(cwd)).trim().split("\n")[0];
		if (root) return `${root}..HEAD`;
	} catch {}

	throw new Error("Unable to determine range: no main or master branch and no root commit found");
}

/** Return full SHAs in chronological order for the given range. */
export function getCommitList(cwd: string, range: string): string[] {
	try {
		const out = execSync(`git log --reverse --format=%H ${range}`, opts(cwd)).trim();
		if (!out) return [];
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** Return the subject line for a single commit. */
export function getCommitSubject(cwd: string, sha: string): string {
	try {
		return execSync(`git log --format=%s -1 ${sha}`, opts(cwd)).trim();
	} catch {
		return "";
	}
}

/** Return combined stat + patch output for a single commit. */
export function getCommitDiff(cwd: string, sha: string): string {
	try {
		return execSync(`git show --stat --patch ${sha}`, opts(cwd)).trim();
	} catch {
		return "";
	}
}

/** Map each commit's stable patch-id to its SHA. */
export function buildPatchIdMap(cwd: string, shas: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const sha of shas) {
		try {
			const out = execSync(`git diff-tree -p ${sha} | git patch-id --stable`, opts(cwd)).trim();
			const patchId = out.split(/\s/)[0] || "";
			if (patchId) map.set(patchId, sha);
		} catch {
			// skip commits without a diff (e.g. empty)
		}
	}
	return map;
}

export interface GitStateIssue {
	type: "rebase_in_progress" | "detached_head" | "dirty_tree";
	message: string;
}

/** Check for git state issues that could break manual mode operations. */
export function checkGitState(cwd: string, expectedBranch?: string): GitStateIssue | null {
	try {
		const gitDir = execSync("git rev-parse --git-dir", opts(cwd)).trim();
		const absGitDir = gitDir.startsWith("/") ? gitDir : join(cwd, gitDir);

		// In-progress rebase blocks everything
		if (existsSync(join(absGitDir, "rebase-merge")) || existsSync(join(absGitDir, "rebase-apply"))) {
			return { type: "rebase_in_progress", message: "Rebase in progress" };
		}

		// Detached HEAD — workhorse needs to be on a branch
		if (expectedBranch) {
			try {
				execSync("git symbolic-ref -q HEAD", opts(cwd));
			} catch {
				return { type: "detached_head", message: "HEAD is detached" };
			}
		}

		// Dirty working tree — uncommitted changes could cause checkout/rebase failures
		const status = execSync("git status --porcelain", opts(cwd)).trim();
		if (status) {
			return { type: "dirty_tree", message: "Uncommitted changes in working tree" };
		}
	} catch {
		// Not a git repo or git not available
	}
	return null;
}

/** Attempt to fix common git state issues. Returns true if fixed. */
export function fixGitState(cwd: string, issue: GitStateIssue, targetBranch?: string): boolean {
	try {
		switch (issue.type) {
			case "rebase_in_progress":
				execSync("git rebase --abort", opts(cwd));
				return true;
			case "detached_head":
				if (targetBranch) {
					execSync(`git checkout ${targetBranch} --quiet`, opts(cwd));
					return true;
				}
				return false;
			case "dirty_tree":
				// Don't auto-fix — user might have intentional changes
				return false;
		}
	} catch {
		return false;
	}
}

/**
 * After a rebase, match old patch-ids to new ones.
 * Returns the new commit list, a remap of old→new SHAs, and SHAs whose
 * patch-id disappeared (squashed/split).
 */
export function remapAfterRebase(
	cwd: string,
	range: string,
	oldMap: Map<string, string>,
): { newList: string[]; remap: Map<string, string>; lost: string[] } {
	const newList = getCommitList(cwd, range);
	const newMap = buildPatchIdMap(cwd, newList);

	const remap = new Map<string, string>();
	const lost: string[] = [];

	for (const [patchId, oldSha] of oldMap) {
		const newSha = newMap.get(patchId);
		if (newSha) {
			remap.set(oldSha, newSha);
		} else {
			lost.push(oldSha);
		}
	}

	return { newList, remap, lost };
}

// ── Fixup audit ─────────────────────────────────────────

/**
 * Extract short commit SHAs (7-12 hex chars) referenced in overseer text.
 * Looks near "commit" keywords, in backticks, in --fixup refs, and at line starts.
 */
export function extractTaggedSHAs(text: string): string[] {
	const shas = new Set<string>();

	// SHAs in backticks: `abc1234`
	for (const m of text.matchAll(/`([0-9a-f]{7,12})`/g)) {
		shas.add(m[1].toLowerCase());
	}

	// "commit" near a SHA
	for (const m of text.matchAll(/\bcommit\b[^0-9a-z]{0,30}\b([0-9a-f]{7,12})\b/gi)) {
		shas.add(m[1].toLowerCase());
	}

	// --fixup=SHA or --fixup SHA
	for (const m of text.matchAll(/--fixup[= ]([0-9a-f]{7,12})\b/gi)) {
		shas.add(m[1].toLowerCase());
	}

	// SHA at start of line (git log --oneline output)
	for (const m of text.matchAll(/^([0-9a-f]{7,12})\s/gm)) {
		shas.add(m[1].toLowerCase());
	}

	return [...shas];
}

/**
 * Snapshot patch-ids for all commits in base..HEAD.
 * Returns Map<fullSha, patchId>. Keyed by SHA so duplicate subjects
 * are tracked independently. Empty base means "all commits from root".
 */
export function snapshotPatchIds(cwd: string, base: string): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const cmd = base
			? `git rev-list --reverse ${base}..HEAD`
			: `git rev-list --reverse HEAD`;
		const shas = execSync(cmd, {
			cwd, encoding: "utf-8", timeout: 10000,
		}).trim().split("\n").filter(Boolean);

		for (const sha of shas) {
			const pidOut = execSync(`git diff-tree --root -p ${sha} | git patch-id --stable`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();
			const patchId = pidOut.split(/\s/)[0] || "";

			if (patchId) map.set(sha, patchId);
		}
	} catch {
		// best-effort
	}
	return map;
}

/**
 * Resolve short SHAs to full SHAs with subjects. No dedup —
 * two commits with the same subject produce two entries.
 */
export function resolveTaggedCommits(cwd: string, shortShas: string[]): Array<{ sha: string; subject: string }> {
	const commits: Array<{ sha: string; subject: string }> = [];
	for (const s of shortShas) {
		try {
			const fullSha = execSync(`git rev-parse ${s}`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();
			const subject = execSync(`git log --format=%s -1 ${fullSha}`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();
			if (fullSha && subject) commits.push({ sha: fullSha, subject });
		} catch {
			// skip unresolvable SHAs
		}
	}
	return commits;
}

/**
 * Find the parent of the oldest tagged commit — used as the base for snapshotting.
 * Returns null if resolution fails, "" for root commits (no parent).
 */
export function findSnapshotBase(cwd: string, shas: string[]): string | null {
	const resolved = shas.map(s => {
		try {
			return execSync(`git rev-parse ${s}`, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		} catch { return ""; }
	}).filter(Boolean);

	if (resolved.length === 0) return null;

	let oldest: string;
	try {
		oldest = execSync(
			`git merge-base --octopus ${resolved.join(" ")}`,
			{ cwd, encoding: "utf-8", timeout: 5000 },
		).trim();
	} catch {
		return null;
	}
	if (!oldest) return null;

	try {
		return execSync(`git rev-parse ${oldest}~1`, {
			cwd, encoding: "utf-8", timeout: 5000,
		}).trim();
	} catch {
		// Root commit — no parent. Return "" so snapshotPatchIds includes all commits.
		return "";
	}
}

/**
 * Given before/after snapshots (keyed by SHA) and tagged commits,
 * return subjects whose patch-id still exists unchanged in the after set.
 */
export function detectUnchanged(
	before: Map<string, string>,
	after: Map<string, string>,
	taggedCommits: Array<{ sha: string; subject: string }>,
): string[] {
	const afterPids = new Set(after.values());
	const unchanged: string[] = [];
	for (const { sha, subject } of taggedCommits) {
		const beforePid = before.get(sha);
		if (beforePid && afterPids.has(beforePid)) {
			unchanged.push(subject);
		}
	}
	return unchanged;
}

/**
 * Find oldSha's replacement after a rewrite (amend/rebase).
 * Returns the new SHA, or null if the commit was lost (squashed/dropped).
 */
export function remapCommit(cwd: string, oldSha: string): string | null {
	// Still an ancestor of HEAD? No rewrite.
	try {
		execSync(`git merge-base --is-ancestor ${oldSha} HEAD`, opts(cwd));
		return oldSha;
	} catch { /* rewritten */ }

	// Collect fingerprints of the old commit
	let oldPid = "";
	try {
		const out = execSync(`git diff-tree --root -p ${oldSha} | git patch-id --stable`, opts(cwd)).trim();
		oldPid = out.split(/\s/)[0] || "";
	} catch { /* best-effort */ }
	const subject = getCommitSubject(cwd, oldSha);
	if (!oldPid && !subject) return null;

	// Get branch commits to search
	let range: string;
	try { range = resolveRange(cwd, ""); } catch { return null; }
	let shas: string[];
	try {
		shas = execSync(`git log --reverse --format=%H ${range}`, opts(cwd))
			.trim().split("\n").filter(Boolean);
	} catch {
		return null;
	}

	// 1. Patch-id match (exact diff fingerprint — survives reword/amend)
	if (oldPid) {
		for (const sha of shas) {
			try {
				const out = execSync(`git diff-tree --root -p ${sha} | git patch-id --stable`, opts(cwd)).trim();
				if (out.split(/\s/)[0] === oldPid) return sha;
			} catch { /* skip */ }
		}
	}

	// 2. Subject + parent-tree match (handles content changes with same subject)
	if (subject) {
		let oldParentTree = "";
		try {
			const parent = execSync(`git rev-parse ${oldSha}^`, opts(cwd)).trim();
			oldParentTree = execSync(`git rev-parse ${parent}^{tree}`, opts(cwd)).trim();
		} catch { /* root commit or error */ }

		if (oldParentTree) {
			for (const sha of shas) {
				if (getCommitSubject(cwd, sha) !== subject) continue;
				try {
					const parent = execSync(`git rev-parse ${sha}^`, opts(cwd)).trim();
					const parentTree = execSync(`git rev-parse ${parent}^{tree}`, opts(cwd)).trim();
					if (parentTree === oldParentTree) return sha;
				} catch { /* skip */ }
			}
		}

		// 3. Subject-only (last resort)
		for (const sha of shas) {
			if (getCommitSubject(cwd, sha) === subject) return sha;
		}
	}

	// Lost (squashed, dropped)
	return null;
}
