/** Test-only: bootstrap pi TUI theme for log-view rendering tests. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

let piEntryPath: string | null = null;
let piModule: Promise<any> | null = null;

function findPiEntry(): string {
	if (piEntryPath) return piEntryPath;

	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(here, "..", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js"),
		path.join(here, "..", "..", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js"),
		"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js",
		"/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js",
	];

	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
		candidates.unshift(path.join(npmRoot, "@mariozechner", "pi-coding-agent", "dist", "index.js"));
	} catch {}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			piEntryPath = candidate;
			return candidate;
		}
	}

	throw new Error("Could not find @mariozechner/pi-coding-agent. Install pi or add a local node_modules symlink.");
}

export function loadPiAgent(): Promise<any> {
	if (piModule) return piModule;
	piModule = import(pathToFileURL(findPiEntry()).href);
	return piModule;
}
