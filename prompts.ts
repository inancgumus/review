import type { LoopMode, PromptSet, ReviewPromptParams } from "./types.js";
import { reviewPrompts } from "./prompts-review.js";
import { execPrompts } from "./prompts-exec.js";

export const promptSets: Record<LoopMode, PromptSet> = {
	review: reviewPrompts,
	exec: execPrompts,
};

// Backward-compat exports (used by index.ts for the default review mode)
export function buildReviewPrompt(p: ReviewPromptParams): string {
	return promptSets.review.buildReviewPrompt(p);
}

export function buildFixPrompt(reviewText: string, contextPaths: string[], round: number): string {
	return promptSets.review.buildFixPrompt(reviewText, contextPaths, round);
}
