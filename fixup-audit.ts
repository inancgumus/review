import { execSync } from "node:child_process";

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
 * Returns Map<subject, patchId>. Patch-id fingerprints just the delta
 * a commit introduces, so downstream commits that inherit upstream
 * changes don't produce false positives.
 */
export function snapshotPatchIds(cwd: string, base: string): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const shas = execSync(`git rev-list --reverse ${base}..HEAD`, {
			cwd, encoding: "utf-8", timeout: 10000,
		}).trim().split("\n").filter(Boolean);

		for (const sha of shas) {
			const subject = execSync(`git log --format=%s -1 ${sha}`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();

			const pidOut = execSync(`git diff-tree -p ${sha} | git patch-id --stable`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();
			const patchId = pidOut.split(/\s/)[0] || "";

			if (subject && patchId) map.set(subject, patchId);
		}
	} catch {
		// best-effort
	}
	return map;
}

/**
 * Resolve short SHAs to their commit subjects.
 * Returns unique subjects in commit order.
 */
export function resolveSubjects(cwd: string, shas: string[]): string[] {
	const subjects: string[] = [];
	for (const sha of shas) {
		try {
			const subject = execSync(`git log --format=%s -1 ${sha}`, {
				cwd, encoding: "utf-8", timeout: 5000,
			}).trim();
			if (subject && !subjects.includes(subject)) subjects.push(subject);
		} catch {
			// skip unresolvable SHAs
		}
	}
	return subjects;
}

/**
 * Find the parent of the oldest tagged commit — used as the base for snapshotting.
 * Returns empty string if unable to determine.
 */
export function findSnapshotBase(cwd: string, shas: string[]): string {
	try {
		const resolved = shas.map(s => {
			try {
				return execSync(`git rev-parse ${s}`, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
			} catch { return ""; }
		}).filter(Boolean);

		if (resolved.length === 0) return "";

		// Common ancestor of all tagged commits — the oldest on a linear branch
		const oldest = execSync(
			`git merge-base --octopus ${resolved.join(" ")}`,
			{ cwd, encoding: "utf-8", timeout: 5000 },
		).trim();

		if (!oldest) return "";

		return execSync(`git rev-parse ${oldest}~1`, {
			cwd, encoding: "utf-8", timeout: 5000,
		}).trim();
	} catch {
		return "";
	}
}

/**
 * Given before/after snapshots and a list of tagged subjects,
 * return subjects whose patch-id did NOT change (workhorse didn't fix them).
 */
export function detectUnchanged(
	before: Map<string, string>,
	after: Map<string, string>,
	taggedSubjects: string[],
): string[] {
	const unchanged: string[] = [];
	for (const subject of taggedSubjects) {
		const beforePid = before.get(subject);
		const afterPid = after.get(subject);
		if (beforePid && afterPid && beforePid === afterPid) {
			unchanged.push(subject);
		}
	}
	return unchanged;
}
