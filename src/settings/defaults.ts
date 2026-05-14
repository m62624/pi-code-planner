import type { PlannerSettings } from "./schema";

export const DEFAULT_INSTRUCTION_CONTENT = {
	discovery: "",
	plan: "",
	work_item: "",
	refactor: "",
	api_check: "",
	documentation: "",
	compact: "",
	commit_style: "",
} as const;

export const DEFAULT_SETTINGS: PlannerSettings = {
	version: 1,
	instructions: {
		discovery: "instructions/discovery.md",
		plan: "instructions/plan.md",
		work_item: "instructions/work_item.md",
		refactor: "instructions/refactor.md",
		api_check: "instructions/api_check.md",
		documentation: "instructions/documentation.md",
		compact: "instructions/compact.md",
		commit_style: "instructions/commit_style.md",
	},
	refactor: {
		maxIterations: 3,
		compactAfterEachIteration: true,
	},
	git: {
		shellToolNames: ["bash"],
		blockedCommitPatterns: ["\\bgit\\s+commit\\b"],
		blockedDangerousPatterns: [
			"\\bgit\\s+reset\\b",
			"\\bgit\\s+rebase\\b",
			"\\bgit\\s+merge\\b",
			"\\bgit\\s+checkout\\b",
			"\\bgit\\s+switch\\b",
			"\\bgit\\s+branch\\s+-D\\b",
			"\\bgit\\s+clean\\b",
		],
		deleteChildBranch: true,
		archiveChildPlans: false,
	},
	verificationCommands: [],
};
