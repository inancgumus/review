import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const opts = (cwd: string) => ({ cwd, encoding: "utf-8" as const, timeout: 10000 });

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
