import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Config, ThinkingLevel } from "./types.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

const DEFAULTS: Config = {
	reviewerModel: "openai/gpt-5.4",
	fixerModel: "anthropic/claude-opus-4-6",
	reviewerThinking: "xhigh",
	fixerThinking: "xhigh",
	maxRounds: 10,
	reviewMode: "fresh",
};

/** Own config file — separate from pi's settings.json to avoid overwrites. */
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "review.json");

function readJSON(filePath: string): Record<string, any> | null {
	try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
	catch { return null; }
}

export function loadConfig(_cwd: string): Config {
	const saved = readJSON(CONFIG_FILE) ?? {};
	return {
		reviewerModel: saved.reviewerModel ?? DEFAULTS.reviewerModel,
		fixerModel: saved.fixerModel ?? DEFAULTS.fixerModel,
		reviewerThinking: validThinking(saved.reviewerThinking) ?? DEFAULTS.reviewerThinking,
		fixerThinking: validThinking(saved.fixerThinking) ?? DEFAULTS.fixerThinking,
		maxRounds: saved.maxRounds ?? DEFAULTS.maxRounds,
		reviewMode: saved.reviewMode === "incremental" ? "incremental" : DEFAULTS.reviewMode,
	};
}

/** Reads enabledModels from pi's settings.json (read-only, never writes to it). */
export function getScopedModels(cwd: string): string[] {
	const sources = [
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
		path.join(cwd, ".pi", "settings.json"),
	];
	let models: string[] = [];
	for (const src of sources) {
		const raw = readJSON(src);
		if (Array.isArray(raw?.enabledModels)) models = raw.enabledModels;
	}
	return models;
}

function validThinking(v: unknown): ThinkingLevel | undefined {
	return THINKING_LEVELS.includes(v as ThinkingLevel) ? (v as ThinkingLevel) : undefined;
}

export { THINKING_LEVELS };

export function saveConfigField(key: keyof Config, value: string | number): void {
	let config: Record<string, any> = {};
	try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch { /* new */ }
	config[key] = value;
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}
