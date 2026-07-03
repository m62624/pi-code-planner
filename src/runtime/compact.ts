import { getInstructionSectionContent } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import type {
	InstructionKey,
	InstructionSectionName,
} from "../instructions/schema";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlannerPreflightResult } from "./preflight";

export const PLANNER_COMPACT_MARKER = "[PI-CODE-PLANNER COMPACT INSTRUCTIONS]";
export const PLANNER_SYSTEM_INSTRUCTIONS_HEADER = "[SYSTEM_INSTRUCTIONS]";

export interface PlannerCompactRuntimeState {
	plannerControlledCompactInFlight: boolean;
	// True only while a real compaction is running — set once the SDK has passed
	// preparation and emitted `session_before_compact`, cleared on
	// `session_compact`, on `onError`, or by the max-duration safety. The idle
	// watchdog reads it so it never nudges the model mid-compaction, yet can
	// still rescue a compact boundary that neither completed nor errored.
	compactionInFlight: boolean;
}

export interface PlannerCompactInstructionBundleInput {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	preflight: PlannerPreflightResult;
	sectionName: InstructionSectionName;
}

export interface PlannerCompactInstructionBundle {
	sectionName: InstructionSectionName;
	sections: PlannerCompactInstructionSection[];
	text: string;
}

export interface PlannerCompactInstructionSection {
	key: InstructionKey;
	found: boolean;
	content: string;
	defaultPath: string;
	appendPath: string | null;
}

export type PlannerPostCompactDelivery = "followUp";

export function createPlannerCompactRuntimeState(): PlannerCompactRuntimeState {
	return { plannerControlledCompactInFlight: false, compactionInFlight: false };
}

export function markPlannerCompactionInFlight(
	state: PlannerCompactRuntimeState,
): void {
	state.compactionInFlight = true;
}

export function clearPlannerCompactionInFlight(
	state: PlannerCompactRuntimeState,
): void {
	state.compactionInFlight = false;
}

export function markPlannerControlledCompactStarted(
	state: PlannerCompactRuntimeState,
): void {
	state.plannerControlledCompactInFlight = true;
}

export function clearPlannerControlledCompact(
	state: PlannerCompactRuntimeState,
): void {
	state.plannerControlledCompactInFlight = false;
}

export function consumePlannerControlledCompact(
	state: PlannerCompactRuntimeState,
): boolean {
	const value = state.plannerControlledCompactInFlight;
	state.plannerControlledCompactInFlight = false;
	return value;
}

export async function buildPlannerCompactInstructionBundle(
	input: PlannerCompactInstructionBundleInput,
): Promise<PlannerCompactInstructionBundle> {
	const sections = await collectInstructionSections(input);
	return {
		sectionName: input.sectionName,
		sections,
		text: buildPlannerCompactInstructions({
			preflight: input.preflight,
			sectionName: input.sectionName,
			sections,
		}),
	};
}

export function buildPlannerCompactInstructions(input: {
	preflight: PlannerPreflightResult;
	sectionName: InstructionSectionName;
	sections: readonly PlannerCompactInstructionSection[];
}): string {
	const state =
		input.preflight.context.status === "ready"
			? input.preflight.context.state
			: null;
	const planId =
		input.preflight.context.status === "ready"
			? input.preflight.context.activePlanId
			: null;

	return [
		PLANNER_COMPACT_MARKER,
		"",
		"Create a compact summary for pi-code-planner continuation.",
		"Keep the summary concise. Preserve durable pointers and decisions instead of replaying the full conversation.",
		"Preserve planner state, artifact paths, git gate, completed work, open risks, and the exact next required planner action.",
		// After compaction the model only has this summary, not the original
		// chat — so it must never treat its own recollection as ground truth.
		// state.json (read via planner_status) is the only durable source of
		// truth for what's actually complete.
		"Do not mark any planner step complete unless state.json already says it is complete.",
		"After compaction, continuation must call planner_status before choosing any next action.",
		"",
		"## Planner State",
		`- planId: ${planId ?? "(none)"}`,
		`- stage: ${state?.stage ?? "(none)"}`,
		`- step: ${state?.step ?? "(none)"}`,
		`- stepStatus: ${state?.stepStatus ?? "(none)"}`,
		`- activeTaskId: ${state?.activeTaskId ?? "(none)"}`,
		`- currentBranch: ${state?.currentBranch ?? "(none)"}`,
		`- compactBoundaries: ${JSON.stringify(state?.compactBoundaries ?? null)}`,
		`- requiresCompact: ${String(state?.requiresCompact ?? false)}`,
		"",
		"## Runtime Gate",
		`- action: ${input.preflight.decision.action}`,
		`- reason: ${input.preflight.decision.reason ?? "(none)"}`,
		`- allowedTools: ${input.preflight.decision.allowedTools.join(", ") || "(none)"}`,
		"",
		"## Artifact Pointers",
		...artifactLines(input.preflight),
		"",
		"## Instruction Sections",
		...sectionLines(input.sections),
	].join("\n");
}

export function buildPlannerPostCompactMessage(input: {
	preflight: PlannerPreflightResult;
	sections: readonly PlannerCompactInstructionSection[];
}): string {
	const state =
		input.preflight.context.status === "ready"
			? input.preflight.context.state
			: null;
	const planId =
		input.preflight.context.status === "ready"
			? input.preflight.context.activePlanId
			: null;

	return [
		PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
		"",
		"A Pi compaction boundary has completed while pi-code-planner is active.",
		"Do not continue from the previous chat state.",
		"Call planner_status immediately before using any other tool. Follow the exact reported stage, step, allowed wrappers, and recovery gate.",
		"Use discovery.md as the project summary. Read source files only when the exact current action needs details that are not recorded there.",
		"If planner_status reports recovery, use recovery tools and ask the user before destructive repair.",
		"Do not use raw git. Use planner git wrappers only.",
		...(state?.lastStuckReportPath
			? [
					"",
					"## Stuck Recovery Reset",
					"The previous attempt is evidence, not a negative state. Do not continue the same loop from memory.",
					"After planner_status, read the stuck report and diff_stat.md, choose one smallest falsifying probe, record the observed fact, then patch only from evidence.",
					"Do not repeat the previous attempt unless new evidence proves it was correct.",
				]
			: []),
		"",
		"## Current Stored Position",
		`- planId: ${planId ?? "(none)"}`,
		`- stage: ${state?.stage ?? "(none)"}`,
		`- step: ${state?.step ?? "(none)"}`,
		`- stepStatus: ${state?.stepStatus ?? "(none)"}`,
		`- activeTaskId: ${state?.activeTaskId ?? "(none)"}`,
		`- lastStuckAttemptId: ${state?.lastStuckAttemptId ?? "(none)"}`,
		`- lastStuckReportPath: ${state?.lastStuckReportPath ?? "(none)"}`,
		"",
		"## Auto-Compact Instruction Sections",
		...sectionLines(input.sections),
	].join("\n");
}

export function enqueuePlannerPostCompactMessage(input: {
	message: string;
	isIdle: boolean;
	hasPendingMessages: boolean;
	sendUserMessage: (
		message: string,
		options?: { deliverAs: "followUp" },
	) => void;
}): PlannerPostCompactDelivery {
	input.sendUserMessage(input.message, { deliverAs: "followUp" });
	return "followUp";
}

export function formatPlannerCompactFailure(error: Error): string {
	const guidance = isPlannerCompactNothingToCompactError(error)
		? " Pi has nothing to compact (the session is below its size threshold), so retrying planner_request_compact can never succeed. The pending compact boundary was resolved automatically — its goal (a small context) is already met."
		: isPlannerCompactTimeoutError(error)
			? " The persisted compact boundary is still pending. Call planner_request_compact to retry. If local generation remains slow, open Pi /settings and set HTTP idle timeout to 5 min or disabled."
			: " The persisted compact boundary is still pending. Call planner_request_compact to retry after resolving the failure.";
	return `Planner compact failed: ${error.message}.${guidance}`;
}

export function isPlannerCompactTimeoutError(error: Error): boolean {
	return /timed?\s*out|timeout|time limit|deadline|exceeded/i.test(
		error.message,
	);
}

/**
 * Pi 0.80+ refuses to compact a session that is already below its size
 * threshold, throwing "Nothing to compact (session too small)" (or "Already
 * compacted"). Retrying can never succeed in that state, so the planner must
 * resolve the pending boundary as already satisfied instead of looping.
 */
export function isPlannerCompactNothingToCompactError(error: Error): boolean {
	return /nothing to compact|too small|already compacted/i.test(error.message);
}

/**
 * Message shown when the planner skips compaction on purpose — either predicted
 * (small session / below threshold) or after resolving a failed compaction. The
 * boundary is satisfied without an LLM round-trip and the flow continues.
 */
export function formatPlannerCompactSkipped(reason: string): string {
	return `Planner compaction skipped (${reason}). The compact boundary is satisfied without compacting — call planner_status and continue with the reported step.`;
}

export type PlannerCompactionSkipReason = "below_threshold";

export interface PlannerCompactionDecision {
	run: boolean;
	reason: PlannerCompactionSkipReason | null;
}

/**
 * Decide whether a planner-controlled compaction should actually run when the
 * model reaches a compact step, or be skipped and the boundary resolved without
 * an LLM round-trip. Pure, so it unit-tests without the SDK.
 *
 * `below_threshold`: context is not yet close to the window, so there is nothing
 * worth compacting (this is also what makes a too-small session skip compaction
 * entirely, avoiding Pi's "Nothing to compact" throw at the source). The floor
 * is `contextWindow - reserveTokens * reserveMultiplier`; with a multiplier > 1
 * it sits *below* Pi's own auto-compaction floor (multiplier 1), so the planner
 * compaction fires first at a stage boundary and Pi's generic auto-compaction
 * rarely triggers. Scales with the window (correct on a 32k or a 1M window).
 * When `tokens` is unknown (e.g. right after a compaction) the threshold cannot
 * be evaluated, so we let compaction run — layer B (onError) backstops the rare
 * throw that follows.
 */
export function decidePlannerCompactionRun(input: {
	tokens: number | null;
	contextWindow: number;
	reserveTokens: number;
	reserveMultiplier: number;
}): PlannerCompactionDecision {
	if (input.tokens !== null && input.contextWindow > 0) {
		const floor =
			input.contextWindow - input.reserveTokens * input.reserveMultiplier;
		if (input.tokens <= floor) {
			return { run: false, reason: "below_threshold" };
		}
	}
	return { run: true, reason: null };
}

export async function collectAutoCompactInstructionSections(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	preflight: PlannerPreflightResult;
}): Promise<PlannerCompactInstructionSection[]> {
	return await collectInstructionSections({
		...input,
		sectionName: "auto-compact",
	});
}

async function collectInstructionSections(
	input: PlannerCompactInstructionBundleInput,
): Promise<PlannerCompactInstructionSection[]> {
	const keys = input.preflight.instructions?.keys ?? [];
	const paths = createInstructionPaths(input.projectPaths);
	const sections: PlannerCompactInstructionSection[] = [];
	for (const key of keys) {
		const content = await getInstructionSectionContent(
			input.fs,
			paths,
			key,
			input.sectionName,
		);
		sections.push({
			key,
			found: content.section.found,
			content: content.section.content,
			defaultPath: content.defaultPath,
			appendPath: content.appendPath,
		});
	}
	return sections;
}

function artifactLines(preflight: PlannerPreflightResult): string[] {
	if (preflight.context.status !== "ready") {
		return [`- context: ${preflight.context.status}`];
	}
	const planPaths = preflight.context.planPaths;
	const lines = [
		`- request.md: ${planPaths.requestMd}`,
		`- goal.md: ${planPaths.goalMd}`,
		`- plan.md: ${planPaths.planMd}`,
		`- discovery.md: ${planPaths.discoveryMd}`,
		`- questions.md: ${planPaths.questionsMd}`,
		`- decisions.md: ${planPaths.decisionsMd}`,
		`- verify.md: ${planPaths.verifyMd}`,
		`- tasksDir: ${planPaths.tasksDir}`,
	];
	return lines;
}

function sectionLines(
	sections: readonly PlannerCompactInstructionSection[],
): string[] {
	if (sections.length === 0) {
		return ["- (none)"];
	}
	return sections.flatMap((section) => [
		`### ${section.key}`,
		`- default: ${section.defaultPath}`,
		`- append: ${section.appendPath ?? "(none)"}`,
		section.found ? section.content : "(section not provided)",
	]);
}
