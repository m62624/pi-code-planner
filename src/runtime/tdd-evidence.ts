import type { PlannerFs } from "../storage/fs";

export const PRE_IMPLEMENTATION_SECTION = "Pre-Implementation Proof Contract";
export const POST_IMPLEMENTATION_SECTION =
	"Post-Implementation Counterexample Review";
export const MERGE_SCOPE_AUDIT_SECTION = "Task Merge Scope Audit";

export const PRE_IMPLEMENTATION_FIELDS = [
	"failingSignal",
	"productionPath",
	"successSignal",
	"outOfScopeFiles",
] as const;

export const POST_IMPLEMENTATION_FIELDS = [
	"counterexample",
	"boundaryValue",
	"oppositeCase",
	"regressionRisk",
	"scopeCheck",
	"action",
] as const;

export const MERGE_SCOPE_AUDIT_FIELDS = [
	"acceptanceCriteriaCovered",
	"changedFilesMatchScope",
	"testsRun",
	"debugRemoved",
	"commitMessageMatchesBehavior",
	"branchDriftCheck",
] as const;

/** True when the value is empty or a known placeholder token. */
export function isTddPlaceholder(value: string): boolean {
	return isPlaceholder(value);
}

export async function validatePreImplementationProofContract(
	fs: PlannerFs,
	path: string,
): Promise<string | null> {
	return await validateTddSection({
		fs,
		path,
		section: PRE_IMPLEMENTATION_SECTION,
		fields: PRE_IMPLEMENTATION_FIELDS,
	});
}

export async function validatePostImplementationCounterexampleReview(
	fs: PlannerFs,
	path: string,
): Promise<string | null> {
	return await validateTddSection({
		fs,
		path,
		section: POST_IMPLEMENTATION_SECTION,
		fields: POST_IMPLEMENTATION_FIELDS,
	});
}

export async function validateTaskMergeScopeAudit(
	fs: PlannerFs,
	path: string,
): Promise<string | null> {
	return await validateTddSection({
		fs,
		path,
		section: MERGE_SCOPE_AUDIT_SECTION,
		fields: MERGE_SCOPE_AUDIT_FIELDS,
	});
}

async function validateTddSection(input: {
	fs: PlannerFs;
	path: string;
	section: string;
	fields: readonly string[];
}): Promise<string | null> {
	if (!(await input.fs.exists(input.path))) {
		return `Required planner artifact is missing or empty: ${input.path}.`;
	}
	const text = await input.fs.readText(input.path);
	if (text.trim().length === 0) {
		return `Required planner artifact is missing or empty: ${input.path}.`;
	}
	const sections = parseLevelTwoSections(text);
	const content = sections.get(input.section);
	if (!content || isBlank(content)) {
		return `tdd.md must include a non-empty "## ${input.section}" section before this transition. Required fields: ${input.fields.map((field) => `- ${field}: <concrete evidence>`).join(", ")}.`;
	}
	for (const field of input.fields) {
		const value = fieldValue(content, field);
		if (!value || isPlaceholder(value)) {
			return `tdd.md "## ${input.section}" must include "- ${field}: <concrete evidence>" before this transition. Required fields: ${input.fields.join(", ")}.`;
		}
	}
	return null;
}

function parseLevelTwoSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];

	for (const line of text.split(/\r?\n/)) {
		const heading = /^##\s+(\S.*)$/.exec(line);
		if (heading) {
			if (current) sections.set(current, buffer.join("\n").trim());
			current = heading[1].trim();
			buffer = [];
			continue;
		}
		if (current) buffer.push(line);
	}

	if (current) sections.set(current, buffer.join("\n").trim());
	return sections;
}

function fieldValue(content: string, field: string): string | null {
	const match = new RegExp(`^- ${field}:\\s*(.+)$`, "m").exec(content);
	return match?.[1]?.trim() ?? null;
}

function isBlank(value: string): boolean {
	return value.trim().length === 0;
}

function isPlaceholder(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized.length === 0 ||
		normalized === "todo" ||
		normalized === "n/a" ||
		normalized === "none" ||
		normalized === "(none)" ||
		normalized === "unknown" ||
		normalized === "tbd"
	);
}
