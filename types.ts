export type LoopMode = "review" | "exec";

export type ReviewMode = "fresh" | "incremental";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	overseerModel: string;
	workhorseModel: string;
	overseerThinking: ThinkingLevel;
	workhorseThinking: ThinkingLevel;
	maxRounds: number;
	reviewMode: ReviewMode;
}

export type Phase = "idle" | "reviewing" | "fixing";

export interface OverseerPromptParams {
	focus: string;
	round: number;
	reviewMode: ReviewMode;
	contextPaths: string[];
	workhorseSummaries: string[];
	unchangedCommits: string[];
}

export interface PromptSet {
	buildOverseerPrompt(p: OverseerPromptParams): string;
	buildWorkhorsePrompt(overseerText: string, contextPaths: string[], round: number): string;
}

export type Verdict = "approved" | "changes_requested" | null;

export interface RoundResult {
	round: number;
	verdict: Verdict;
	overseerText: string;
	workhorseSummary: string;
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
	overseerLeafId: string | null;
	anchorEntryId: string | null;
	workhorseSummaries: string[];
	roundResults: RoundResult[];
	patchSnapshot: Map<string, string> | null;
	snapshotBase: string;
	taggedSubjects: string[];
	unchangedCommits: string[];
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
		overseerLeafId: null,
		anchorEntryId: null,
		workhorseSummaries: [],
		roundResults: [],
		patchSnapshot: null,
		snapshotBase: "",
		taggedSubjects: [],
		unchangedCommits: [],
		...overrides,
	};
}
