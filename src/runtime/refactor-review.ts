import type { PlannerFs } from "../storage/fs";

const REQUIRED_REFACTOR_SECTIONS = [
	"Changed Surface",
	"Complexity",
	"Duplication",
	"Naming And Boundaries",
	"Edge Cases",
	"Refactor Decision",
] as const;

export type RefactorDecision = "changed" | "kept";

export interface RefactorReviewInput {
	changedSurface: string;
	complexity: string;
	duplication: string;
	namingAndBoundaries: string;
	edgeCases: string;
	decision: RefactorDecision;
	changesApplied: string | null;
	whyKept: string | null;
}

export interface RefactorReviewValidation {
	valid: boolean;
	reason: string | null;
	decision: RefactorDecision | null;
}

export async function validateRefactorReviewArtifact(
	fs: PlannerFs,
	path: string,
): Promise<string | null> {
	if (!(await fs.exists(path))) {
		return `Required planner artifact is missing or empty: ${path}.`;
	}
	const text = await fs.readText(path);
	const validation = validateRefactorReviewMarkdown(text);
	return validation.valid
		? null
		: [
				`Refactor review is incomplete: ${validation.reason} (${path}).`,
				"Do not call planner_finish_step again yet. Open refactor.md, inspect the active task diff, fill the missing review section with concrete observations, then retry planner_finish_step.",
			].join(" ");
}

export function validateRefactorReviewMarkdown(
	text: string,
): RefactorReviewValidation {
	if (text.trim().length === 0) {
		return invalid("refactor.md is empty");
	}

	const sections = parseLevelTwoSections(text);
	for (const section of REQUIRED_REFACTOR_SECTIONS) {
		if (!sections.has(section)) {
			return invalid(`missing section "## ${section}"`);
		}
		if (isBlankSection(sections.get(section) ?? "")) {
			return invalid(`section "## ${section}" is empty`);
		}
	}

	const decisionText = sections.get("Refactor Decision") ?? "";
	const decision = parseRefactorDecision(decisionText);
	if (!decision) {
		return invalid(
			`"## Refactor Decision" must contain "Decision: changed" or "Decision: kept"`,
		);
	}

	if (decision === "kept") {
		const kept = sections.get("Why Kept");
		if (!kept || isBlankSection(kept)) {
			return invalid(
				`"Decision: kept" requires a non-empty "## Why Kept" section grounded in the actual diff`,
			);
		}
	}

	if (decision === "changed") {
		const applied = sections.get("Changes Applied");
		if (!applied || isBlankSection(applied)) {
			return invalid(
				`"Decision: changed" requires a non-empty "## Changes Applied" section`,
			);
		}
	}

	return { valid: true, reason: null, decision };
}

export function formatRefactorReviewMarkdown(
	input: RefactorReviewInput,
): string {
	return [
		"# Refactor Review",
		"",
		"## Changed Surface",
		input.changedSurface.trim(),
		"",
		"## Complexity",
		input.complexity.trim(),
		"",
		"## Duplication",
		input.duplication.trim(),
		"",
		"## Naming And Boundaries",
		input.namingAndBoundaries.trim(),
		"",
		"## Edge Cases",
		input.edgeCases.trim(),
		"",
		"## Refactor Decision",
		`Decision: ${input.decision}`,
		"",
		"## Changes Applied",
		input.changesApplied?.trim() || "- (not applicable)",
		"",
		"## Why Kept",
		input.whyKept?.trim() || "- (not applicable)",
		"",
	].join("\n");
}

function parseLevelTwoSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];

	for (const line of text.split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			if (current) {
				sections.set(current, buffer.join("\n").trim());
			}
			current = heading[1].trim();
			buffer = [];
			continue;
		}
		if (current) buffer.push(line);
	}

	if (current) {
		sections.set(current, buffer.join("\n").trim());
	}
	return sections;
}

function parseRefactorDecision(text: string): RefactorDecision | null {
	const match = /^Decision:\s*(changed|kept)\s*$/im.exec(text);
	return match ? (match[1] as RefactorDecision) : null;
}

function isBlankSection(text: string): boolean {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.every((line) => /^[-*]\s*$/.test(line) || /^\([^)]*\)$/.test(line));
}

function invalid(reason: string): RefactorReviewValidation {
	return { valid: false, reason, decision: null };
}
