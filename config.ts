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

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

function readJSON(filePath: string): Record<string, any> | null {
	try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
	catch { return null; }
}

function validThinking(v: unknown): ThinkingLevel | undefined {
	return THINKING_LEVELS.includes(v as ThinkingLevel) ? (v as ThinkingLevel) : undefined;
}

export { THINKING_LEVELS };

export function loadConfig(_cwd: string): Config {
	const saved = readJSON(SETTINGS_PATH)?.["review"] ?? {};
	return {
		reviewerModel: saved.reviewerModel ?? DEFAULTS.reviewerModel,
		fixerModel: saved.fixerModel ?? DEFAULTS.fixerModel,
		reviewerThinking: validThinking(saved.reviewerThinking) ?? DEFAULTS.reviewerThinking,
		fixerThinking: validThinking(saved.fixerThinking) ?? DEFAULTS.fixerThinking,
		maxRounds: saved.maxRounds ?? DEFAULTS.maxRounds,
		reviewMode: saved.reviewMode === "incremental" ? "incremental" : DEFAULTS.reviewMode,
	};
}

/** Reads enabledModels from pi's settings.json (read-only for model picker). */
export function getScopedModels(cwd: string): string[] {
	const sources = [SETTINGS_PATH, path.join(cwd, ".pi", "settings.json")];
	let models: string[] = [];
	for (const src of sources) {
		const raw = readJSON(src);
		if (Array.isArray(raw?.enabledModels)) models = raw.enabledModels;
	}
	return models;
}

export function saveConfigField(key: keyof Config, value: string | number): void {
	let settings: Record<string, any> = {};
	try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")); } catch { /* new */ }
	if (!settings["review"]) settings["review"] = {};
	settings["review"][key] = value;
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}
