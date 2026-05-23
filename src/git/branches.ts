import { sanitizeIdPart } from "../storage/ids";

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
	return sanitizeIdPart(value).replace(/\.+/g, ".") || "unnamed";
}
