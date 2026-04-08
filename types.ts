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

export type Verdict = "approved" | "changes_requested" | null;

export interface RoundResult {
	round: number;
	verdict: Verdict;
	reviewText: string;
	fixerSummary: string;
}

export interface LoopState {
	phase: Phase;
	round: number;
	focus: string;
	contextPaths: string[];
	maxRounds: number;
	reviewMode: ReviewMode;
	originalModelStr: string;
	originalThinking: string;
	reviewLeafId: string | null;
	fixerSummaries: string[];
	roundResults: RoundResult[];
}

export function newState(overrides: Partial<LoopState> = {}): LoopState {
	return {
		phase: "idle",
		round: 0,
		focus: "",
		contextPaths: [],
		maxRounds: 10,
		reviewMode: "fresh",
		originalModelStr: "",
		originalThinking: "xhigh",
		reviewLeafId: null,
		fixerSummaries: [],
		roundResults: [],
		...overrides,
	};
}
