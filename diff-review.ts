/**
 * Editor-based diff annotation for code review.
 * Opens a commit diff in $EDITOR, parses user comments back with file:line references.
 * No comments = approve. Comments = structured feedback.
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 10000 };

export interface Annotation {
	file: string;
	startLine: number;
	endLine: number;
	side: "old" | "new";
	comment: string;
}

export interface ReviewResult {
	approved: boolean;
	annotations: Annotation[];
	/** Formatted feedback string for the workhorse, or empty if approved. */
	feedback: string;
}

function git(cwd: string, ...args: string[]): string {
	return execSync(`git ${args.join(" ")}`, { ...GIT_OPTS, cwd }).trimEnd();
}

/**
 * Open a commit diff in $EDITOR for annotation. Returns structured review result.
 * Pass originalEditor to bypass env overrides (e.g. when EDITOR is blocked during loop).
 */
export function reviewCommitInEditor(sha: string, cwd: string, originalEditor?: string): ReviewResult {
	const diff = git(cwd, "--no-pager", "diff", "--no-ext-diff", `${sha}~1`, sha);
	const subject = git(cwd, "log", "--format=%s", "-1", sha);

	const header = [
		`# Review: ${sha.slice(0, 7)} ${subject}`,
		`#`,
		`# Type comments on a new line below the code you're commenting on.`,
		`# No comments = approve. Save and close when done.`,
		``,
	].join("\n");

	const reviewContent = header + "\n" + diff + "\n";
	const editFile = join(tmpdir(), `review-${sha.slice(0, 7)}-${Date.now()}.diff`);
	writeFileSync(editFile, reviewContent);

	const editor = originalEditor || process.env.EDITOR || process.env.VISUAL || "vim";
	const isGui = /code|subl|zed|atom|gedit|mate/i.test(editor);
	const editorArgs = isGui ? ["--wait", editFile] : [editFile];
	const result = spawnSync(editor, editorArgs, { stdio: "inherit" });

	let editedContent: string;
	try {
		editedContent = readFileSync(editFile, "utf-8");
	} catch {
		return { approved: true, annotations: [], feedback: "" };
	} finally {
		try { unlinkSync(editFile); } catch {}
	}

	if (result.status !== 0) {
		return { approved: true, annotations: [], feedback: "" };
	}

	const annotations = parseAnnotations(reviewContent, editedContent);

	if (annotations.length === 0) {
		return { approved: true, annotations, feedback: "" };
	}

	const feedbackLines = annotations.map(a => {
		const lines = a.startLine === a.endLine ? `${a.endLine}` : `${a.startLine}-${a.endLine}`;
		const loc = a.file && a.endLine ? `${sha.slice(0, 7)}:${a.file}:${lines}` : "";
		return loc ? `${loc} — ${a.comment}` : a.comment;
	});

	return {
		approved: false,
		annotations,
		feedback: feedbackLines.join("\n"),
	};
}

/** Parse annotations by walking original and edited diff in parallel. */
export function parseAnnotations(originalContent: string, editedContent: string): Annotation[] {
	const origLines = originalContent.split("\n");
	const editedLines = editedContent.split("\n");

	let origIdx = 0;
	let currentFile = "";
	let newLineNum = 0;
	let oldLineNum = 0;
	let lastCodeLine = 0;
	let rangeStart = 0;
	let lastIsOld = false;
	const annotations: Annotation[] = [];

	for (let i = 0; i < editedLines.length; i++) {
		const l = editedLines[i];

		// Match against next expected original line
		if (origIdx < origLines.length && l === origLines[origIdx]) {
			origIdx++;

			const fileMatch = l.match(/^diff --git a\/(.*) b\//);
			if (fileMatch) { currentFile = fileMatch[1]; rangeStart = 0; continue; }

			const hunkMatch = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (hunkMatch) {
				oldLineNum = parseInt(hunkMatch[1]);
				newLineNum = parseInt(hunkMatch[2]);
				rangeStart = 0;
				continue;
			}

			if (l.startsWith(" ")) { lastCodeLine = newLineNum; lastIsOld = false; newLineNum++; oldLineNum++; }
			else if (l.startsWith("+") && !l.startsWith("+++")) { lastCodeLine = newLineNum; lastIsOld = false; newLineNum++; }
			else if (l.startsWith("-") && !l.startsWith("---")) { lastCodeLine = oldLineNum; lastIsOld = true; oldLineNum++; }

			if (rangeStart === -1) rangeStart = lastCodeLine;
			continue;
		}

		// User addition: empty line = range separator
		if (l.trim() === "") {
			rangeStart = -1;
			continue;
		}

		// Non-empty user text = annotation
		const commentLines = [l];
		while (i + 1 < editedLines.length &&
			(origIdx >= origLines.length || editedLines[i + 1] !== origLines[origIdx])) {
			i++;
			commentLines.push(editedLines[i]);
		}

		const comment = commentLines.map(c => c.trimEnd()).join("\n").trim();
		if (!comment) continue;

		const startLine = rangeStart > 0 ? rangeStart : lastCodeLine;
		annotations.push({
			file: currentFile,
			startLine,
			endLine: lastCodeLine,
			side: lastIsOld ? "old" : "new",
			comment,
		});
		rangeStart = 0;
	}

	return annotations;
}
