import { requiredString } from "./params";
import { asObject } from "./values";
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

export const DOUBT_VERIFICATION_STATUSES = [
	"passed",
	"failed",
	"not_run",
	"unknown",
] as const;
export type DoubtVerificationStatus =
	(typeof DOUBT_VERIFICATION_STATUSES)[number];

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

/**
 * Stack-, language- and tool-agnostic cheat-sheet of every valid finding shape.
 * Appended to every doubt-review rejection so that a model (even a small local
 * one) can see the complete grammar at once and converge in a single retry,
 * instead of fixing one field, breaking another, and bouncing between
 * incremental errors. References no concrete command, framework or ecosystem.
 */
export const DOUBT_FINDING_SHAPE_HINT = [
	"Valid finding shapes (status -> required proofLevel -> required nextAction):",
	`  - proven_bug   -> ${[...PROVEN_PROOF_LEVELS].join(" | ")} -> create_revision_task`,
	`  - disproven    -> ${[...DISPROVEN_PROOF_LEVELS].join(" | ")} -> no_action`,
	"  - needs_probe  -> insufficient_evidence -> run_probe",
	"  - not_a_bug    -> (any proofLevel) -> no_action (must include evidence)",
].join("\n");

const BLOCKING_DOUBT_PATTERNS = [
	/\bplaceholder\b/i,
	/\bstub\b/i,
	/\bfake\b/i,
	/\btodo[-\s]?only\b/i,
	/\bhardcoded\b/i,
	/\bsurface[-\s]?level\b/i,
	/\bsuperficial\b/i,
	/\bunresolved\s+(requirement|task|work|issue)\b/i,
	/\bmissing\s+(task|implementation|behavior|test|coverage)\b/i,
	/\bnot\s+implemented\b/i,
];

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
	verificationEvidence: DoubtVerificationEvidence[];
	possibleErrors: DoubtFinding[];
}

export interface DoubtVerificationEvidence {
	command: string;
	status: DoubtVerificationStatus;
	evidence: string;
}

export interface DoubtReviewValidation {
	valid: boolean;
	reason: string | null;
	errors: string[];
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
		throw new TypeError(
			"possibleErrors must contain at least one finding. If everything is clean, add a finding with status=not_a_bug (plus evidence) or status=disproven (proofLevel=disproven_by_test or disproven_by_code). Do not pass an empty array.",
		);
	}
	const verificationEvidence = arrayOfObjects(
		object.verificationEvidence,
		"verificationEvidence",
	).map(parseVerificationEvidence);
	if (verificationEvidence.length === 0) {
		throw new TypeError(
			"verificationEvidence must contain at least one command/check from discovery.md ## Verification Protocol.",
		);
	}
	return {
		summary: requiredString(object, "summary"),
		verificationEvidence,
		possibleErrors,
	};
}

export function formatDoubtReviewMarkdown(review: DoubtReview): string {
	return [
		"# Doubt Review",
		"",
		"## Verification Evidence",
		"",
		...review.verificationEvidence.flatMap((entry) => [
			`- command: ${entry.command}`,
			`  status: ${entry.status}`,
			`  evidence: ${entry.evidence}`,
		]),
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
	const errors: string[] = [];
	let provenBugCount = 0;
	let needsProbeCount = 0;
	const ids = new Set<string>();
	for (const entry of review.verificationEvidence) {
		if (!entry.command.trim()) {
			errors.push("verificationEvidence.command must be non-empty.");
		}
		if (!DOUBT_VERIFICATION_STATUSES.includes(entry.status)) {
			errors.push(
				`Invalid verificationEvidence status: ${entry.status}. Expected one of: ${DOUBT_VERIFICATION_STATUSES.join(", ")}.`,
			);
		}
		if (!entry.evidence.trim()) {
			errors.push("verificationEvidence.evidence must be non-empty.");
		}
	}
	for (const finding of review.possibleErrors) {
		if (ids.has(finding.id)) {
			errors.push(`Duplicate finding id: ${finding.id}.`);
			continue;
		}
		ids.add(finding.id);
		// Collect every violation for this finding (not just the first) so the
		// caller can report all of them at once.
		errors.push(...collectFindingStatusErrors(finding));
		if (finding.status === "proven_bug") provenBugCount += 1;
		if (finding.status === "needs_probe") needsProbeCount += 1;
	}
	return finalizeValidation(errors, provenBugCount, needsProbeCount);
}

export function validateDoubtReviewMarkdown(
	content: string,
): DoubtReviewValidation {
	if (!/^# Doubt Review\s*$/m.test(content)) {
		return invalid("verify.md must contain a top-level '# Doubt Review'.");
	}
	if (!/^## Verification Evidence\s*$/m.test(content)) {
		return invalid("Doubt Review must contain '## Verification Evidence'.");
	}
	if (!/^## Possible Errors\s*$/m.test(content)) {
		return invalid("Doubt Review must contain '## Possible Errors'.");
	}
	const evidenceValidation = validateMarkdownVerificationEvidence(content);
	if (!evidenceValidation.valid) return evidenceValidation;
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
		const findingErrors = collectFindingStatusErrors({
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
		if (findingErrors.length > 0) return invalid(findingErrors.join("\n"));
		if (status === "proven_bug") provenBugCount += 1;
		if (status === "needs_probe") needsProbeCount += 1;
	}
	return finalizeValidation([], provenBugCount, needsProbeCount);
}

function validateMarkdownVerificationEvidence(
	content: string,
): DoubtReviewValidation {
	const match = content.match(
		/^## Verification Evidence\s*$([\s\S]*?)^## Possible Errors\s*$/m,
	);
	const section = match?.[1]?.trim() ?? "";
	if (!section) {
		return invalid(
			"Doubt Review must include command-level verification evidence.",
		);
	}
	const entries = section
		.split(/(?=^- command:\s+)/m)
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) {
		return invalid(
			"Doubt Review must include at least one verification command.",
		);
	}
	for (const entry of entries) {
		const command = fieldValue(entry, "command");
		const status = fieldValue(entry, "status");
		const evidence = fieldValue(entry, "evidence");
		if (!command) {
			return invalid("Verification evidence entry is missing command.");
		}
		if (!status) {
			return invalid("Verification evidence entry is missing status.");
		}
		if (
			!DOUBT_VERIFICATION_STATUSES.includes(status as DoubtVerificationStatus)
		) {
			return invalid(
				`Invalid verification evidence status: ${status}. Expected one of: ${DOUBT_VERIFICATION_STATUSES.join(", ")}.`,
			);
		}
		if (!evidence) {
			return invalid("Verification evidence entry is missing evidence.");
		}
	}
	return finalizeValidation([], 0, 0);
}

/**
 * Returns every verification-protocol violation at once (missing evidence and
 * unsatisfied commands), so the caller can surface them together. The guidance
 * is deliberately stack-/tool-agnostic and keyed off the reported status:
 *  - a command that FAILED when run is a real local failure -> proven_bug or
 *    needs_probe only;
 *  - a command that could NOT be run here (not_run/unknown — e.g. the tool is
 *    not installed) can also be closed terminally as not_a_bug with evidence
 *    (it is handled elsewhere, e.g. CI). This terminal resolution is what stops
 *    the step from deadlocking on a check the environment cannot physically run
 *    — needs_probe alone cannot resolve it, since it would block the exit.
 */
export function collectVerificationProtocolErrors(
	review: DoubtReview,
	discoveryMd: string,
): string[] {
	const protocol = extractVerificationProtocol(discoveryMd);
	if (protocol.length === 0) {
		return [
			"discovery.md must include ## Verification Protocol before planner_doubt_review can prove the result.",
		];
	}
	const requiredCommands = protocol
		.map(extractProtocolCommand)
		.filter((command): command is string => Boolean(command));
	const missing: string[] = [];
	const failed: string[] = [];
	const unverifiable: string[] = [];
	for (const command of requiredCommands) {
		const evidence = review.verificationEvidence.find((entry) =>
			commandsMatch(entry.command, command),
		);
		if (!evidence) {
			missing.push(command);
			continue;
		}
		if (evidence.status === "passed") {
			continue;
		}
		// "failed" = ran and failed locally (real failure). Anything else
		// ("not_run"/"unknown") = could not be run here, so a terminal not_a_bug
		// (with evidence) is also an acceptable resolution.
		const ranAndFailed = evidence.status === "failed";
		if (!findingCoversCommand(review, command, !ranAndFailed)) {
			(ranAndFailed ? failed : unverifiable).push(command);
		}
	}
	const errors: string[] = [];
	if (missing.length > 0) {
		errors.push(
			`planner_doubt_review is missing verificationEvidence for ${missing.length} required protocol command(s):\n` +
				missing.map((c) => `  - ${c}`).join("\n") +
				"\nAdd all of them to verificationEvidence in one call.",
		);
	}
	if (failed.length > 0) {
		errors.push(
			`Required protocol command(s) did not pass:\n` +
				failed.map((c) => `  - ${c}`).join("\n") +
				"\nFor each, add one finding to possibleErrors that names the command (in claim/verification/evidence) and covers it:" +
				"\n  - real failure you reproduced -> status proven_bug, proofLevel reproduced_command, nextAction create_revision_task" +
				"\n  - needs more proof before you can call it a bug -> status needs_probe, proofLevel insufficient_evidence, nextAction run_probe",
		);
	}
	if (unverifiable.length > 0) {
		errors.push(
			`Required protocol command(s) could not be run here (status not_run/unknown):\n` +
				unverifiable.map((c) => `  - ${c}`).join("\n") +
				"\nFor each, add one finding to possibleErrors that names the command (in claim/verification/evidence) and resolves it:" +
				"\n  - cannot run locally but you confirmed it is handled elsewhere (e.g. it runs in CI) -> status not_a_bug, nextAction no_action, with evidence of where it is covered" +
				"\n  - you still need to run or investigate it -> status needs_probe, proofLevel insufficient_evidence, nextAction run_probe",
		);
	}
	return errors;
}

/**
 * Back-compatible single-message wrapper around
 * {@link collectVerificationProtocolErrors}; returns null when the review
 * satisfies the verification protocol.
 */
export function validateDoubtReviewAgainstVerificationProtocol(
	review: DoubtReview,
	discoveryMd: string,
): string | null {
	const errors = collectVerificationProtocolErrors(review, discoveryMd);
	return errors.length > 0 ? errors.join("\n\n") : null;
}

function collectFindingStatusErrors(finding: DoubtFinding): string[] {
	const errors: string[] = [];
	if (
		finding.status === "proven_bug" &&
		!PROVEN_PROOF_LEVELS.has(finding.proofLevel)
	) {
		errors.push(
			`Finding ${finding.id} is marked proven_bug but proofLevel ${finding.proofLevel} is not proof. Reproduce it with a test/command or prove the exact code/spec contradiction first.`,
		);
	}
	if (
		finding.status === "proven_bug" &&
		finding.nextAction !== "create_revision_task"
	) {
		errors.push(
			`Finding ${finding.id} is proven_bug and must use nextAction create_revision_task.`,
		);
	}
	if (
		finding.status === "disproven" &&
		!DISPROVEN_PROOF_LEVELS.has(finding.proofLevel)
	) {
		errors.push(
			`Finding ${finding.id} is disproven but proofLevel must be disproven_by_test or disproven_by_code.`,
		);
	}
	if (finding.status === "disproven" && finding.nextAction !== "no_action") {
		errors.push(`Finding ${finding.id} is disproven and must use no_action.`);
	}
	if (
		finding.status === "needs_probe" &&
		(finding.proofLevel !== "insufficient_evidence" ||
			finding.nextAction !== "run_probe")
	) {
		errors.push(
			`Finding ${finding.id} needs_probe must use proofLevel insufficient_evidence and nextAction run_probe.`,
		);
	}
	if (finding.status === "not_a_bug" && finding.nextAction !== "no_action") {
		errors.push(`Finding ${finding.id} is not_a_bug and must use no_action.`);
	}
	if (finding.status === "not_a_bug" && finding.evidence.length === 0) {
		errors.push(
			`Finding ${finding.id} must include evidence explaining why it is not a bug.`,
		);
	}
	if (
		finding.status !== "proven_bug" &&
		finding.status !== "needs_probe" &&
		mentionsBlockingDoubt(finding)
	) {
		errors.push(
			`Finding ${finding.id} mentions placeholder/stub/superficial/missing or unresolved work. It must be proven_bug or needs_probe; do not close it as ${finding.status}.`,
		);
	}
	return errors;
}

function mentionsBlockingDoubt(finding: DoubtFinding): boolean {
	const text = [
		finding.claim,
		finding.specReference,
		finding.codePath,
		finding.verification,
		...finding.evidence,
	].join("\n");
	return BLOCKING_DOUBT_PATTERNS.some((pattern) => pattern.test(text));
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

function parseVerificationEvidence(
	value: Record<string, unknown>,
): DoubtVerificationEvidence {
	return {
		command: requiredString(value, "command"),
		status: requiredEnum(value, "status", DOUBT_VERIFICATION_STATUSES),
		evidence: requiredString(value, "evidence"),
	};
}

export function extractVerificationProtocolCommands(content: string): string[] {
	return extractVerificationProtocol(content)
		.map(extractProtocolCommand)
		.filter((c): c is string => Boolean(c));
}

export function extractVerificationProtocol(content: string): string[] {
	const lines = content.split(/\r?\n/);
	const result: string[] = [];
	let collecting = false;
	for (const line of lines) {
		const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const title = heading[2].trim().toLowerCase();
			if (collecting) break;
			collecting = title === "verification protocol";
			continue;
		}
		// Only bullet list items count as protocol commands. Prose lines (e.g. an
		// introductory "These commands are available:") under the heading are
		// ignored so they never become phantom required commands.
		if (collecting && /^[-*]\s+\S/.test(line.trim())) {
			result.push(line.trim());
		}
	}
	return result;
}

function extractProtocolCommand(line: string): string | null {
	const normalized = line
		.replace(/^[-*]\s*/, "")
		.replace(/`/g, "")
		.trim();
	if (
		!normalized ||
		/\b(unknown|unset|none|n\/a|not discovered)\b/i.test(normalized)
	) {
		return null;
	}
	if (/^(working directory|cwd|flags?)\s*:/i.test(normalized)) {
		return null;
	}
	// A line ending in a colon is a prose heading (e.g. "Commands available:"),
	// not a runnable command — never treat it as a required protocol command.
	if (normalized.endsWith(":")) {
		return null;
	}
	const match =
		/^(test|tests|lint|format|build|ci|check|checks)\s*:\s*(.+)$/i.exec(
			normalized,
		);
	const command = match?.[2]?.trim() ?? normalized;
	return command.length > 0 ? command : null;
}

function commandsMatch(left: string, right: string): boolean {
	const normalizedLeft = normalizeCommand(left);
	const normalizedRight = normalizeCommand(right);
	return (
		normalizedLeft === normalizedRight ||
		normalizedLeft.includes(normalizedRight) ||
		normalizedRight.includes(normalizedLeft)
	);
}

function normalizeCommand(value: string): string {
	return value.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findingCoversCommand(
	review: DoubtReview,
	command: string,
	allowNotABug: boolean,
): boolean {
	const needle = normalizeCommand(command);
	return review.possibleErrors.some((finding) => {
		const covers =
			finding.status === "proven_bug" ||
			finding.status === "needs_probe" ||
			(allowNotABug && finding.status === "not_a_bug");
		if (!covers) {
			return false;
		}
		const text = normalizeCommand(
			[
				finding.claim,
				finding.specReference,
				finding.codePath,
				finding.verification,
				...finding.evidence,
				...finding.counterEvidence,
			].join("\n"),
		);
		return text.includes(needle);
	});
}

function fieldValue(block: string, field: string): string {
	const match = block.match(
		new RegExp(`^\\s*(?:-\\s*)?${field}:\\s*(.+)$`, "m"),
	);
	return match?.[1]?.trim() ?? "";
}

function invalid(reason: string): DoubtReviewValidation {
	return {
		valid: false,
		reason,
		errors: [reason],
		provenBugCount: 0,
		needsProbeCount: 0,
	};
}

function finalizeValidation(
	errors: string[],
	provenBugCount: number,
	needsProbeCount: number,
): DoubtReviewValidation {
	return {
		valid: errors.length === 0,
		reason: errors.length > 0 ? errors.join("\n") : null,
		errors,
		provenBugCount,
		needsProbeCount,
	};
}

function formatList(values: readonly string[]): string {
	return values.length
		? values.map((value) => `- ${value}`).join("\n")
		: "- (none)";
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
