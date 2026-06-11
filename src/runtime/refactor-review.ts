import type { PlannerFs } from "../storage/fs";

const REQUIRED_REFACTOR_SECTIONS = [
	"Changed Surface",
	"Complexity",
	"Duplication",
	"Naming And Boundaries",
	"Edge Cases",
	"Category Review",
	"Refactor Decision",
] as const;

export const REFACTOR_REVIEW_CATEGORIES = [
	"duplication",
	"naming",
	"control_flow",
	"abstraction_level",
	"hidden_coupling",
	"error_handling",
	"test_clarity",
	"debug_leftovers",
	"scope_creep",
] as const;
export type RefactorReviewCategory =
	(typeof REFACTOR_REVIEW_CATEGORIES)[number];

export const REFACTOR_REVIEW_CATEGORY_STATUSES = [
	"ok",
	"issue",
	"not_applicable",
] as const;
export type RefactorReviewCategoryStatus =
	(typeof REFACTOR_REVIEW_CATEGORY_STATUSES)[number];

export type RefactorDecision = "changed" | "kept";

export interface RefactorCategoryReview {
	category: RefactorReviewCategory;
	status: RefactorReviewCategoryStatus;
	evidence: string;
	action: string;
}

export interface RefactorReviewInput {
	changedSurface: string;
	complexity: string;
	duplication: string;
	namingAndBoundaries: string;
	edgeCases: string;
	categoryReviews: RefactorCategoryReview[];
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

	const categoryValidation = validateCategoryReviewMarkdown(
		sections.get("Category Review") ?? "",
	);
	if (!categoryValidation.valid) return categoryValidation;

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
		"## Category Review",
		...formatCategoryReviews(input.categoryReviews),
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

export function validateRefactorCategoryReviews(
	reviews: RefactorCategoryReview[],
): RefactorReviewValidation {
	const seen = new Set<RefactorReviewCategory>();
	for (const category of REFACTOR_REVIEW_CATEGORIES) {
		const review = reviews.find((item) => item.category === category);
		if (!review) {
			return invalid(`missing category review: ${category}`);
		}
		if (seen.has(review.category)) {
			return invalid(`duplicate category review: ${review.category}`);
		}
		seen.add(review.category);
		if (!REFACTOR_REVIEW_CATEGORY_STATUSES.includes(review.status)) {
			return invalid(`invalid category status: ${review.status}`);
		}
		if (!review.evidence.trim()) {
			return invalid(`category ${review.category} requires evidence`);
		}
		if (!review.action.trim()) {
			return invalid(`category ${review.category} requires action`);
		}
	}
	return { valid: true, reason: null, decision: null };
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

function validateCategoryReviewMarkdown(
	text: string,
): RefactorReviewValidation {
	for (const category of REFACTOR_REVIEW_CATEGORIES) {
		const block = levelThreeSection(text, category);
		if (!block) {
			return invalid(`missing "### ${category}" category review`);
		}
		const status = fieldValue(block, "status");
		const evidence = fieldValue(block, "evidence");
		const action = fieldValue(block, "action");
		if (
			!status ||
			!REFACTOR_REVIEW_CATEGORY_STATUSES.includes(
				status as RefactorReviewCategoryStatus,
			)
		) {
			return invalid(
				`category ${category} must include status ok, issue, or not_applicable`,
			);
		}
		if (!evidence || isPlaceholder(evidence)) {
			return invalid(`category ${category} requires concrete evidence`);
		}
		if (!action || isPlaceholder(action)) {
			return invalid(`category ${category} requires concrete action`);
		}
	}
	return { valid: true, reason: null, decision: null };
}

function formatCategoryReviews(
	reviews: readonly RefactorCategoryReview[],
): string[] {
	return reviews.flatMap((review) => [
		`### ${review.category}`,
		`- status: ${review.status}`,
		`- evidence: ${review.evidence.trim()}`,
		`- action: ${review.action.trim()}`,
		"",
	]);
}

function levelThreeSection(text: string, heading: string): string | null {
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^###\s+(.+?)\s*$/.exec(line);
		if (match) {
			if (current) sections.set(current, buffer.join("\n").trim());
			current = match[1].trim();
			buffer = [];
			continue;
		}
		if (current) buffer.push(line);
	}
	if (current) sections.set(current, buffer.join("\n").trim());
	return sections.get(heading) ?? null;
}

function fieldValue(text: string, field: string): string | null {
	const match = new RegExp(`^- ${field}:\\s*(.+)$`, "m").exec(text);
	return match?.[1]?.trim() ?? null;
}

function isPlaceholder(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized.length === 0 ||
		normalized === "todo" ||
		normalized === "none" ||
		normalized === "(none)" ||
		normalized === "n/a" ||
		normalized === "unknown"
	);
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
