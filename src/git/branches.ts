import { compactIdPart } from "../storage/ids";

const BRANCH_PART_CHARS = 32;

export function planBranchName(planId: string): string {
	return `plan/${sanitizeBranchPart(planId)}`;
}

export function taskBranchName(planId: string, taskId: string): string {
	return `task/${sanitizeBranchPart(planId)}/${sanitizeBranchPart(taskId)}`;
}

export function experimentBranchName(
	planId: string,
	taskId: string,
	attemptId: string,
): string {
	return `experiment/${sanitizeBranchPart(planId)}/${sanitizeBranchPart(taskId)}/${sanitizeBranchPart(attemptId)}`;
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
