export const DOUBT_REVIEW_TOOL_NAMES = ["planner_doubt_review"] as const;
export type PlannerDoubtReviewToolName =
	(typeof DOUBT_REVIEW_TOOL_NAMES)[number];

export const DOUBT_FINDING_STATUSES = [
	"proven_bug",
	"disproven",
	"needs_probe",
	"not_a_bug",
] as const;
export type DoubtFindingStatus = (typeof DOUBT_FINDING_STATUSES)[number];

export const DOUBT_PROOF_LEVELS = [
	"reproduced_test",
	"reproduced_command",
	"code_path_proven",
	"spec_contradiction",
	"disproven_by_test",
	"disproven_by_code",
	"insufficient_evidence",
] as const;
export type DoubtProofLevel = (typeof DOUBT_PROOF_LEVELS)[number];

export const DOUBT_NEXT_ACTIONS = [
	"create_revision_task",
	"run_probe",
	"no_action",
] as const;
export type DoubtNextAction = (typeof DOUBT_NEXT_ACTIONS)[number];

export const DOUBT_RISK_CATEGORIES = [
	"requirement_mismatch",
	"missing_test",
	"boundary_case",
	"integration_break",
	"state_machine_error",
	"persistence_error",
	"recovery_error",
	"wrong_file_scope",
	"user_flow_regression",
	"cleanup_or_debug_leftover",
] as const;
export type DoubtRiskCategory = (typeof DOUBT_RISK_CATEGORIES)[number];

const PROVEN_PROOF_LEVELS = new Set<DoubtProofLevel>([
	"reproduced_test",
	"reproduced_command",
	"code_path_proven",
	"spec_contradiction",
]);

const DISPROVEN_PROOF_LEVELS = new Set<DoubtProofLevel>([
	"disproven_by_test",
	"disproven_by_code",
]);

export interface DoubtFinding {
	id: string;
	riskCategory: DoubtRiskCategory;
	status: DoubtFindingStatus;
	proofLevel: DoubtProofLevel;
	claim: string;
	specReference: string;
	codePath: string;
	verification: string;
	evidence: string[];
	counterEvidence: string[];
	nextAction: DoubtNextAction;
}

export interface DoubtReview {
	summary: string;
	possibleErrors: DoubtFinding[];
}

export interface DoubtReviewValidation {
	valid: boolean;
	reason: string | null;
	provenBugCount: number;
	needsProbeCount: number;
}

export function parseDoubtReviewParams(params: unknown): DoubtReview {
	const object = asObject(params);
	const possibleErrors = arrayOfObjects(
		object.possibleErrors,
		"possibleErrors",
	).map(parseFinding);
	if (possibleErrors.length === 0) {
		throw new TypeError("possibleErrors must contain at least one finding.");
	}
	return {
		summary: requiredString(object, "summary"),
		possibleErrors,
	};
}

export function formatDoubtReviewMarkdown(review: DoubtReview): string {
	return [
		"# Doubt Review",
		"",
		"## Possible Errors",
		"",
		...review.possibleErrors.flatMap((finding, index) => [
			`### ${index + 1}. ${finding.id}`,
			"",
			`- riskCategory: ${finding.riskCategory}`,
			`- status: ${finding.status}`,
			`- proofLevel: ${finding.proofLevel}`,
			`- nextAction: ${finding.nextAction}`,
			`- claim: ${finding.claim}`,
			`- specReference: ${finding.specReference}`,
			`- codePath: ${finding.codePath}`,
			`- verification: ${finding.verification}`,
			"",
			"#### Evidence",
			formatList(finding.evidence),
			"",
			"#### Counter Evidence",
			formatList(finding.counterEvidence),
			"",
		]),
		"## Summary",
		"",
		review.summary,
		"",
	].join("\n");
}

export function validateDoubtReview(
	review: DoubtReview,
): DoubtReviewValidation {
	let provenBugCount = 0;
	let needsProbeCount = 0;
	const ids = new Set<string>();
	for (const finding of review.possibleErrors) {
		if (ids.has(finding.id)) {
			return invalid(`Duplicate finding id: ${finding.id}.`);
		}
		ids.add(finding.id);
		const statusValidation = validateFindingStatus(finding);
		if (!statusValidation.valid) return statusValidation;
		if (finding.status === "proven_bug") provenBugCount += 1;
		if (finding.status === "needs_probe") needsProbeCount += 1;
	}
	return {
		valid: true,
		reason: null,
		provenBugCount,
		needsProbeCount,
	};
}

export function validateDoubtReviewMarkdown(
	content: string,
): DoubtReviewValidation {
	if (!/^# Doubt Review\s*$/m.test(content)) {
		return invalid("verify.md must contain a top-level '# Doubt Review'.");
	}
	if (!/^## Possible Errors\s*$/m.test(content)) {
		return invalid("Doubt Review must contain '## Possible Errors'.");
	}
	const findingBlocks = content
		.split(/^###\s+/m)
		.slice(1)
		.map((block) => block.trim())
		.filter(Boolean);
	if (findingBlocks.length === 0) {
		return invalid("Doubt Review must contain at least one finding.");
	}
	let provenBugCount = 0;
	let needsProbeCount = 0;
	for (const block of findingBlocks) {
		const status = fieldValue(block, "status");
		const riskCategory = fieldValue(block, "riskCategory");
		const proofLevel = fieldValue(block, "proofLevel");
		const nextAction = fieldValue(block, "nextAction");
		const claim = fieldValue(block, "claim");
		const specReference = fieldValue(block, "specReference");
		const codePath = fieldValue(block, "codePath");
		const verification = fieldValue(block, "verification");
		for (const [key, value] of Object.entries({
			status,
			riskCategory,
			proofLevel,
			nextAction,
			claim,
			specReference,
			codePath,
			verification,
		})) {
			if (!value) return invalid(`Doubt finding is missing ${key}.`);
		}
		if (!DOUBT_FINDING_STATUSES.includes(status as DoubtFindingStatus)) {
			return invalid(
				`Invalid doubt finding status: ${status}. Expected one of: ${DOUBT_FINDING_STATUSES.join(", ")}.`,
			);
		}
		if (!DOUBT_RISK_CATEGORIES.includes(riskCategory as DoubtRiskCategory)) {
			return invalid(
				`Invalid doubt riskCategory: ${riskCategory}. Expected one of: ${DOUBT_RISK_CATEGORIES.join(", ")}.`,
			);
		}
		if (!DOUBT_PROOF_LEVELS.includes(proofLevel as DoubtProofLevel)) {
			return invalid(
				`Invalid doubt proofLevel: ${proofLevel}. Expected one of: ${DOUBT_PROOF_LEVELS.join(", ")}.`,
			);
		}
		if (!DOUBT_NEXT_ACTIONS.includes(nextAction as DoubtNextAction)) {
			return invalid(
				`Invalid doubt nextAction: ${nextAction}. Expected one of: ${DOUBT_NEXT_ACTIONS.join(", ")}.`,
			);
		}
		const validation = validateFindingStatus({
			id: block.split("\n")[0]?.trim() ?? "(unknown)",
			riskCategory: riskCategory as DoubtRiskCategory,
			status: status as DoubtFindingStatus,
			proofLevel: proofLevel as DoubtProofLevel,
			claim,
			specReference,
			codePath,
			verification,
			evidence: ["markdown evidence present"],
			counterEvidence: [],
			nextAction: nextAction as DoubtNextAction,
		});
		if (!validation.valid) return validation;
		if (status === "proven_bug") provenBugCount += 1;
		if (status === "needs_probe") needsProbeCount += 1;
	}
	return { valid: true, reason: null, provenBugCount, needsProbeCount };
}

function validateFindingStatus(finding: DoubtFinding): DoubtReviewValidation {
	if (
		finding.status === "proven_bug" &&
		!PROVEN_PROOF_LEVELS.has(finding.proofLevel)
	) {
		return invalid(
			`Finding ${finding.id} is marked proven_bug but proofLevel ${finding.proofLevel} is not proof. Reproduce it with a test/command or prove the exact code/spec contradiction first.`,
		);
	}
	if (
		finding.status === "proven_bug" &&
		finding.nextAction !== "create_revision_task"
	) {
		return invalid(
			`Finding ${finding.id} is proven_bug and must use nextAction create_revision_task.`,
		);
	}
	if (
		finding.status === "disproven" &&
		!DISPROVEN_PROOF_LEVELS.has(finding.proofLevel)
	) {
		return invalid(
			`Finding ${finding.id} is disproven but proofLevel must be disproven_by_test or disproven_by_code.`,
		);
	}
	if (finding.status === "disproven" && finding.nextAction !== "no_action") {
		return invalid(
			`Finding ${finding.id} is disproven and must use no_action.`,
		);
	}
	if (
		finding.status === "needs_probe" &&
		(finding.proofLevel !== "insufficient_evidence" ||
			finding.nextAction !== "run_probe")
	) {
		return invalid(
			`Finding ${finding.id} needs_probe must use proofLevel insufficient_evidence and nextAction run_probe.`,
		);
	}
	if (finding.status === "not_a_bug" && finding.nextAction !== "no_action") {
		return invalid(
			`Finding ${finding.id} is not_a_bug and must use no_action.`,
		);
	}
	if (finding.status === "not_a_bug" && finding.evidence.length === 0) {
		return invalid(
			`Finding ${finding.id} must include evidence explaining why it is not a bug.`,
		);
	}
	return { valid: true, reason: null, provenBugCount: 0, needsProbeCount: 0 };
}

function parseFinding(value: Record<string, unknown>): DoubtFinding {
	return {
		id: requiredId(value, "id"),
		riskCategory: requiredEnum(value, "riskCategory", DOUBT_RISK_CATEGORIES),
		status: requiredEnum(value, "status", DOUBT_FINDING_STATUSES),
		proofLevel: requiredEnum(value, "proofLevel", DOUBT_PROOF_LEVELS),
		claim: requiredString(value, "claim"),
		specReference: requiredString(value, "specReference"),
		codePath: requiredString(value, "codePath"),
		verification: requiredString(value, "verification"),
		evidence: requiredStringArray(value.evidence, "evidence"),
		counterEvidence: stringArray(value.counterEvidence, "counterEvidence"),
		nextAction: requiredEnum(value, "nextAction", DOUBT_NEXT_ACTIONS),
	};
}

function fieldValue(block: string, field: string): string {
	const match = block.match(new RegExp(`^- ${field}:\\s*(.+)$`, "m"));
	return match?.[1]?.trim() ?? "";
}

function invalid(reason: string): DoubtReviewValidation {
	return { valid: false, reason, provenBugCount: 0, needsProbeCount: 0 };
}

function formatList(values: readonly string[]): string {
	return values.length
		? values.map((value) => `- ${value}`).join("\n")
		: "- (none)";
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function arrayOfObjects(
	value: unknown,
	key: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.every(isPlainObject)) {
		throw new TypeError(`${key} must be an array of objects.`);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredId(params: Record<string, unknown>, key: string): string {
	const value = requiredString(params, key);
	if (!/^[a-z][a-z0-9-]*$/.test(value)) {
		throw new TypeError(`${key} must be lowercase kebab-case.`);
	}
	return value;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function requiredStringArray(value: unknown, key: string): string[] {
	const result = stringArray(value, key);
	if (result.length === 0) {
		throw new TypeError(`${key} must contain at least one non-empty string.`);
	}
	return result;
}

function stringArray(value: unknown, key: string): string[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${key} must be a string array.`);
	}
	const result = value.map((entry) => {
		if (typeof entry !== "string") {
			throw new TypeError(`${key} must be a string array.`);
		}
		return entry.trim();
	});
	return result.filter((entry) => entry.length > 0);
}

function requiredEnum<const T extends readonly string[]>(
	params: Record<string, unknown>,
	key: string,
	values: T,
): T[number] {
	const value = params[key];
	if (!values.includes(value as T[number])) {
		throw new TypeError(`${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T[number];
}
