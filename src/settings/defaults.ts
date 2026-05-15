import { EXTENSION_NAME } from "../constants";
import type { PlannerSettings } from "./schema";

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
		branchNaming: {
			plan: "planner/{planId}/main",
			child: "planner/{planId}/work/{workItemId}",
			experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
		},
		deleteChildBranch: true,
		archiveChildPlans: false,
	},
	memory: {
		autoDirtyTracking: true,
		dirtyPathIgnorePrefixes: [".git/", `.pi/extensions/${EXTENSION_NAME}/`],
		dirtyPolicy: {
			blockCompact: true,
			blockWorkItemCommit: false,
			blockSignatureRefreshExit: true,
		},
	},
	verificationCommands: [],
};
