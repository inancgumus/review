export type LoopMode = "review" | "exec";

export type ReviewMode = "fresh" | "incremental";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	reviewerModel: string;
	fixerModel: string;
	reviewerThinking: ThinkingLevel;
	fixerThinking: ThinkingLevel;
	maxRounds: number;
	reviewMode: ReviewMode;
}

export type Phase = "idle" | "reviewing" | "fixing";

export interface ReviewPromptParams {
	focus: string;
	round: number;
	reviewMode: ReviewMode;
	contextPaths: string[];
	fixerSummaries: string[];
}

export interface PromptSet {
	buildReviewPrompt(p: ReviewPromptParams): string;
	buildFixPrompt(reviewText: string, contextPaths: string[], round: number): string;
}

export type Verdict = "approved" | "changes_requested" | null;

export interface RoundResult {
	round: number;
	verdict: Verdict;
	reviewText: string;
	fixerSummary: string;
}

export interface LoopState {
	mode: LoopMode;
	phase: Phase;
	round: number;
	focus: string;
	initialRequest: string;
	contextPaths: string[];
	maxRounds: number;
	reviewMode: ReviewMode;
	originalModelStr: string;
	originalThinking: string;
	reviewLeafId: string | null;
	anchorEntryId: string | null;
	fixerSummaries: string[];
	roundResults: RoundResult[];
}

export function newState(overrides: Partial<LoopState> = {}): LoopState {
	return {
		mode: "review",
		phase: "idle",
		round: 0,
		focus: "",
		initialRequest: "",
		contextPaths: [],
		maxRounds: 10,
		reviewMode: "fresh",
		originalModelStr: "",
		originalThinking: "xhigh",
		reviewLeafId: null,
		anchorEntryId: null,
		fixerSummaries: [],
		roundResults: [],
		...overrides,
	};
}
