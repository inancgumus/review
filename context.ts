import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function expandTilde(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Parse `/loop` args into focus text and resolved @path references. */
export function parseArgs(args: string, cwd: string): { focus: string; contextPaths: string[] } {
	const contextPaths: string[] = [];
	const remaining: string[] = [];

	for (const token of args.split(/\s+/)) {
		if (!token.startsWith("@")) { remaining.push(token); continue; }
		const rawPath = token.slice(1);
		const resolved = path.isAbsolute(rawPath) ? expandTilde(rawPath) : path.join(cwd, rawPath);
		try { fs.statSync(resolved); contextPaths.push(resolved); }
		catch { remaining.push(token); }
	}

	return {
		focus: remaining.join(" ").trim() || "all recent code changes",
		contextPaths,
	};
}
