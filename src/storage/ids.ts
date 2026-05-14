import { createHash } from "node:crypto";
import { basename, normalize } from "node:path";

const MAX_SLUG_LENGTH = 48;

function trimDashes(value: string): string {
	return value.replace(/^-+|-+$/g, "");
}

export function sanitizeId(value: string, fallback = "item"): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	const trimmed = trimDashes(normalized).slice(0, MAX_SLUG_LENGTH);
	return trimDashes(trimmed) || fallback;
}

export function shortHash(value: string, length = 8): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function createProjectKey(projectPath: string): string {
	const normalized = normalize(projectPath);
	const name = sanitizeId(basename(normalized), "project");
	return `${name}-${shortHash(normalized)}`;
}

export function createPlanId(title: string, date = new Date()): string {
	const slug = sanitizeId(title, "plan");
	const stamp = date.toISOString().slice(0, 10).replace(/-/g, "");
	return `${slug}-${stamp}`;
}

export function createWorkItemId(title: string): string {
	return sanitizeId(title, "work-item");
}

export function createAttemptId(index: number): string {
	if (!Number.isInteger(index) || index < 1) {
		throw new Error("Attempt index must be a positive integer.");
	}
	return `attempt-${index}`;
}
