export const INSTRUCTION_NAMES = [
	"discovery",
	"plan",
	"work_item",
	"refactor",
	"api_check",
	"documentation",
	"compact",
	"commit_style",
] as const;

export type InstructionName = (typeof INSTRUCTION_NAMES)[number];

export type InstructionPathMap = Record<InstructionName, string>;

export interface RefactorSettings {
	maxIterations: number;
	compactAfterEachIteration: boolean;
}

export interface BranchNamingSettings {
	plan: string;
	child: string;
	experiment: string;
}

export interface GitSettings {
	shellToolNames: string[];
	blockedCommitPatterns: string[];
	blockedDangerousPatterns: string[];
	branchNaming: BranchNamingSettings;
	deleteChildBranch: boolean;
	archiveChildPlans: boolean;
}

export interface MemoryDirtyPolicySettings {
	blockCompact: boolean;
	blockWorkItemCommit: boolean;
	blockSignatureRefreshExit: boolean;
}

export interface MemorySettings {
	dirtyPolicy: MemoryDirtyPolicySettings;
}

export interface PlannerSettings {
	version: 1;
	instructions: InstructionPathMap;
	refactor: RefactorSettings;
	git: GitSettings;
	memory: MemorySettings;
	verificationCommands: string[];
}

export interface SettingsLoadResult {
	settings: PlannerSettings;
	sources: {
		defaults: "built-in";
		globalSettings?: string;
		projectSettings?: string;
		instructions: Partial<Record<InstructionName, string>>;
	};
}

export type PartialPlannerSettings = Partial<{
	instructions: Partial<InstructionPathMap>;
	refactor: Partial<RefactorSettings>;
	git: Partial<GitSettings>;
	memory: Partial<{
		dirtyPolicy: Partial<MemoryDirtyPolicySettings>;
	}>;
	verificationCommands: string[];
}>;
