export type LoopMode = "review" | "exec" | "manual";

export type ReviewMode = "fresh" | "incremental";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	overseerModel: string;
	workhorseModel: string;
	overseerThinking: ThinkingLevel;
	workhorseThinking: ThinkingLevel;
	maxRounds: number;
	reviewMode: ReviewMode;
	plannotator: boolean;
}

export type Phase = "idle" | "reviewing" | "fixing" | "awaiting_feedback";

export interface OverseerPromptParams {
	focus: string;
	round: number;
	reviewMode: ReviewMode;
	contextPaths: string[];
	workhorseSummaries: string[];
	unchangedCommits: string[];
	changedContextPaths: string[];
	// Manual mode
	userFeedback?: string;
	commitSha?: string;
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
	startedAt: number;
	endedAt: number;
	workhorseStartedAt: number;
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
	contextHashes: Map<string, string> | null;
	changedContextPaths: string[];
	loopStartedAt: number;
	roundStartedAt: number;
	// Manual mode
	commitList: string[];
	currentCommitIdx: number;
	patchIdMap: Map<string, string>;
	userFeedback: string;
	manualInnerRound: number;
	manualBase: string;
	pausedElapsed: number;
	hasPlannotator: boolean | null;
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
		contextHashes: null,
		changedContextPaths: [],
		loopStartedAt: 0,
		roundStartedAt: 0,
		commitList: [],
		currentCommitIdx: 0,
		patchIdMap: new Map(),
		userFeedback: "",
		manualInnerRound: 0,
		manualBase: "",
		pausedElapsed: 0,
		hasPlannotator: null,
		...overrides,
	};
}
