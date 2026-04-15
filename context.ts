/**
 * Context — @path file I/O, arg parsing, and context hashing.
 * Single owner for all context-path operations.
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

function readFileContent(filePath: string): string | null {
	try {
		const resolved = expandTilde(filePath);
		const stat = fs.statSync(resolved);
		if (stat.isFile()) {
			if (stat.size > MAX_FILE_SIZE)
				return `[${filePath}: skipped, ${Math.round(stat.size / 1024)}KB > 50KB limit]`;
			return `### ${filePath}\n\`\`\`\n${fs.readFileSync(resolved, "utf-8")}\n\`\`\``;
		}
		if (stat.isDirectory()) return readDirContent(resolved, filePath, new Set());
	} catch { /* skip */ }
	return null;
}

function readDirContent(dirPath: string, displayPath: string, seen: Set<string>): string {
	let realPath: string;
	try { realPath = fs.realpathSync(dirPath); } catch { return ""; }
	if (seen.has(realPath)) return "";
	seen.add(realPath);
	const parts: string[] = [];
	for (const entry of safeDirEntries(dirPath)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dirPath, entry.name);
		const display = path.join(displayPath, entry.name);
		const content = entry.isFile()
			? readFileContent(full)
			: entry.isDirectory()
				? readDirContent(full, display, seen)
				: null;
		if (content) parts.push(content);
	}
	return parts.join("\n\n");
}

function safeDirEntries(dirPath: string): fs.Dirent[] {
	try { return fs.readdirSync(dirPath, { withFileTypes: true }); }
	catch { return []; }
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

export function expandContextPaths(paths: string[]): string {
	if (paths.length === 0) return "";
	const parts: string[] = [];
	for (const p of paths) {
		const content = readFileContent(p);
		if (content) parts.push(content);
	}
	return parts.length > 0 ? "\n\n## Context files\n\n" + parts.join("\n\n") : "";
}

export function snapshotContextHashes(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const p of paths) {
		const content = readFileContent(p);
		if (content) {
			map.set(p, createHash("sha256").update(content).digest("hex"));
		}
	}
	return map;
}

export function findChangedContextPaths(paths: string[], before: Map<string, string>): string[] {
	const now = snapshotContextHashes(paths);
	const changed: string[] = [];
	for (const p of paths) {
		const nowHash = now.get(p);
		const beforeHash = before.get(p);
		if (nowHash && nowHash !== beforeHash) changed.push(p);
	}
	return changed;
}
