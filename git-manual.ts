import { execSync } from "node:child_process";

const opts = (cwd: string) => ({ cwd, encoding: "utf-8" as const, timeout: 10000 });

/**
 * If rangeArg is non-empty, return it as-is.
 * Otherwise detect merge-base with main (fallback master) and return `<base>..HEAD`.
 */
export function resolveRange(cwd: string, rangeArg: string): string {
	if (rangeArg) return rangeArg;

	try {
		const base = execSync("git merge-base HEAD main", opts(cwd)).trim();
		return `${base}..HEAD`;
	} catch {
		// main not found, try master
	}
	try {
		const base = execSync("git merge-base HEAD master", opts(cwd)).trim();
		return `${base}..HEAD`;
	} catch {
		throw new Error("Unable to determine range: no main or master branch found");
	}
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
