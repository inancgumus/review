/**
 * Context — @path file I/O, arg parsing, and context hashing.
 * Single owner for all context-path operations.
 *
 * Raw reading and hashing are separate from prompt formatting.
 * Hashes use raw file bytes so formatting changes cannot produce false diffs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const MAX_FILE_SIZE = 200_000;

function expandTilde(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

// ── Raw reading (no formatting) ─────────────────────────

export interface ContextEntry {
	path: string;
	content: string;
}

function safeDirEntries(dirPath: string): fs.Dirent[] {
	try { return fs.readdirSync(dirPath, { withFileTypes: true }); }
	catch { return []; }
}

/** Collect entries for a path. Directories expand recursively with cycle guard. */
function collectEntries(filePath: string, out: ContextEntry[]): void {
	try {
		const resolved = expandTilde(filePath);
		const stat = fs.statSync(resolved);
		if (stat.isFile()) {
			if (stat.size <= MAX_FILE_SIZE) {
				out.push({ path: filePath, content: fs.readFileSync(resolved, "utf-8") });
			}
		} else if (stat.isDirectory()) {
			collectDirEntries(resolved, filePath, new Set(), out);
		}
	} catch { /* skip missing/unreadable */ }
}

function collectDirEntries(dirPath: string, displayBase: string, seen: Set<string>, out: ContextEntry[]): void {
	let realPath: string;
	try { realPath = fs.realpathSync(dirPath); } catch { return; }
	if (seen.has(realPath)) return;
	seen.add(realPath);
	for (const entry of safeDirEntries(dirPath)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dirPath, entry.name);
		const display = path.join(displayBase, entry.name);
		if (entry.isFile()) {
			try {
				const stat = fs.statSync(full);
				if (stat.size <= MAX_FILE_SIZE) {
					out.push({ path: display, content: fs.readFileSync(full, "utf-8") });
				}
			} catch { /* skip */ }
		} else if (entry.isDirectory()) {
			collectDirEntries(full, display, seen, out);
		}
	}
}

/** Read raw content for each path. Directories expand to individual child files. */
export function readContextPaths(paths: string[]): ContextEntry[] {
	const entries: ContextEntry[] = [];
	for (const p of paths) collectEntries(p, entries);
	return entries;
}

/** Format entries as a "## Context files" markdown block. Empty string for empty input. */
export function formatContextMarkdown(entries: ContextEntry[]): string {
	if (entries.length === 0) return "";
	return "\n\n## Context files\n\n" + entries.map(e => `### ${e.path}\n\`\`\`\n${e.content}\n\`\`\``).join("\n\n");
}

export function parseArgs(args: string, cwd: string): { focus: string; contextPaths: string[] } {
	const contextPaths: string[] = [];
	const remaining: string[] = [];
	for (const token of args.split(/\s+/)) {
		if (!token.startsWith("@")) { remaining.push(token); continue; }
		const rawPath = expandTilde(token.slice(1));
		const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
		try { fs.statSync(resolved); contextPaths.push(resolved); }
		catch { remaining.push(token); }
	}
	return { focus: remaining.join(" ").trim() || "all recent code changes", contextPaths };
}

/** Hash raw file bytes. Formatting changes cannot produce false diffs. */
export function snapshotContextHashes(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of readContextPaths(paths)) {
		map.set(entry.path, createHash("sha256").update(entry.content).digest("hex"));
	}
	return map;
}

export function findChangedContextPaths(paths: string[], before: Map<string, string>): string[] {
	const now = snapshotContextHashes(paths);
	const changed: string[] = [];
	for (const [p, hash] of now) {
		if (hash !== before.get(p)) changed.push(p);
	}
	return changed;
}
