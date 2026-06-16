import { compactIdPart } from "../storage/ids";

// `plan/`, `task/`, `refactor/`, `output/` prefixes are matched elsewhere
// (e.g. planner-ops.ts's deleteManagedBranch guards "plan/" specifically) and
// implicitly assumed stable by existing on-disk plan state — changing a
// prefix here orphans branch references for plans created before the change.
const BRANCH_PART_CHARS = 32;

export function planBranchName(planId: string): string {
	return `plan/${sanitizeBranchPart(planId)}`;
}

export function taskBranchName(planId: string, taskId: string): string {
	return `task/${sanitizeBranchPart(planId)}/${sanitizeBranchPart(taskId)}`;
}

export function refactorBranchName(planId: string, taskId: string): string {
	return `refactor/${sanitizeBranchPart(planId)}/${sanitizeBranchPart(taskId)}`;
}

export function outputBranchName(planId: string): string {
	return `output/${sanitizeBranchPart(planId)}`;
}

function sanitizeBranchPart(value: string): string {
	return compactIdPart(value, BRANCH_PART_CHARS) || "unnamed";
}
