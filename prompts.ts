import type { LoopMode, PromptSet, OverseerPromptParams } from "./types.js";
import { reviewPrompts } from "./prompts-review.js";
import { execPrompts } from "./prompts-exec.js";

export const promptSets: Record<LoopMode, PromptSet> = {
	review: reviewPrompts,
	exec: execPrompts,
};

// Backward-compat exports (used by index.ts for the default loop mode)
export function buildOverseerPrompt(p: OverseerPromptParams): string {
	return promptSets.review.buildOverseerPrompt(p);
}

export function buildWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number): string {
	return promptSets.review.buildWorkhorsePrompt(overseerText, contextPaths, round);
}
