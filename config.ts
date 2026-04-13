import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ReviewMode } from "./types.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	overseerModel: string;
	workhorseModel: string;
	overseerThinking: ThinkingLevel;
	workhorseThinking: ThinkingLevel;
	maxRounds: number;
	reviewMode: ReviewMode;
	plannotator: boolean;
	rewriteHistory: boolean;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

const DEFAULTS: Config = {
	overseerModel: "openai/gpt-5.4",
	workhorseModel: "anthropic/claude-opus-4-6",
	overseerThinking: "xhigh",
	workhorseThinking: "xhigh",
	maxRounds: 10,
	reviewMode: "fresh",
	plannotator: true,
	rewriteHistory: false,
};

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

// Lazy so tests can override via LOOP_SETTINGS_PATH after module load.
function settingsPath(): string {
	return process.env.LOOP_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
}

function readJSON(filePath: string): Record<string, any> | null {
	try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
	catch { return null; }
}

function validThinking(v: unknown): ThinkingLevel | undefined {
	return THINKING_LEVELS.includes(v as ThinkingLevel) ? (v as ThinkingLevel) : undefined;
}

export { THINKING_LEVELS };

export function loadConfig(_cwd: string): Config {
	const saved = readJSON(settingsPath())?.["loop"] ?? {};
	return {
		overseerModel: saved.overseerModel ?? DEFAULTS.overseerModel,
		workhorseModel: saved.workhorseModel ?? DEFAULTS.workhorseModel,
		overseerThinking: validThinking(saved.overseerThinking) ?? DEFAULTS.overseerThinking,
		workhorseThinking: validThinking(saved.workhorseThinking) ?? DEFAULTS.workhorseThinking,
		maxRounds: saved.maxRounds ?? DEFAULTS.maxRounds,
		reviewMode: saved.reviewMode === "incremental" ? "incremental" : DEFAULTS.reviewMode,
		plannotator: saved.plannotator !== false,
		rewriteHistory: saved.rewriteHistory === true,
	};
}

/** Reads enabledModels from pi's settings.json (read-only for model picker). */
export function getScopedModels(cwd: string): string[] {
	const sources = [settingsPath(), path.join(cwd, ".pi", "settings.json")];
	let models: string[] = [];
	for (const src of sources) {
		const raw = readJSON(src);
		if (Array.isArray(raw?.enabledModels)) models = raw.enabledModels;
	}
	return models;
}

export function saveConfigField(key: keyof Config, value: string | number | boolean): void {
	let settings: Record<string, any> = {};
	const p = settingsPath();
	try { settings = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* new */ }
	if (!settings["loop"]) settings["loop"] = {};
	settings["loop"][key] = value;
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
}
