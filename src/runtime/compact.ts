import { getInstructionSectionContent } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import type {
	InstructionKey,
	InstructionSectionName,
} from "../instructions/schema";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { clamp } from "./num";
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
	// Velocity tracking for the growth-margin heuristic. `lastContextTokens` is the
	// context size seen at the previous turn_end; `turnGrowthEwma` is an EWMA of
	// *positive* per-turn deltas. Together they let the proactive monitor pre-empt
	// one typical turn before the floor, instead of trusting only the fixed
	// tool-headroom cushion. A compaction's drop is negative and folds nothing, so
	// the tracker self-heals across a compaction with no explicit reset.
	lastContextTokens: number | null;
	turnGrowthEwma: number;
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
	return {
		plannerControlledCompactInFlight: false,
		compactionInFlight: false,
		lastContextTokens: null,
		turnGrowthEwma: 0,
	};
}

/**
 * Fold this turn's context growth into the EWMA and return the current expected
 * per-turn growth (tokens). Pure w.r.t. inputs, mutates only the tracker fields.
 *
 * Only a *positive* delta is growth: a drop is a compaction reset (or a branch
 * switch), not a turn's accumulation, so it folds nothing and just re-baselines
 * `lastContextTokens`. `alpha` is the EWMA responsiveness (higher tracks recent
 * turns faster). The first observed growth seeds the EWMA directly so a cold start
 * is not dragged down from zero.
 */
export function observeTurnGrowth(
	state: PlannerCompactRuntimeState,
	tokens: number | null,
	alpha: number,
): number {
	if (tokens === null || !Number.isFinite(tokens) || tokens < 0) {
		return state.turnGrowthEwma;
	}
	const prev = state.lastContextTokens;
	state.lastContextTokens = tokens;
	if (prev !== null && tokens > prev) {
		const delta = tokens - prev;
		state.turnGrowthEwma =
			state.turnGrowthEwma <= 0
				? delta
				: alpha * delta + (1 - alpha) * state.turnGrowthEwma;
	}
	return state.turnGrowthEwma;
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

// `output_budget` — already at/over the floor (the reactive catch). `growth_margin`
// — still under the floor, but one typical turn's growth would cross it, so compact
// now while a clean boundary is available rather than risk a mid-turn overflow.
export type PlannerCompactionRunReason = "output_budget" | "growth_margin";

export interface PlannerContextBudgetDecision {
	/** True when context has reached the point where compaction is worthwhile. */
	run: boolean;
	reason: PlannerCompactionRunReason | PlannerCompactionSkipReason | null;
	/** The computed compaction floor (tokens); `projected` above it triggers. */
	floor: number;
	/** Confirmed tokens plus any instructions we are about to inject. */
	projected: number;
	/** Tokens still free below the floor (negative once we are over it). */
	headroom: number;
}

/** Estimate the token cost of text we are about to inject, matching Pi's
 * conservative chars/4 heuristic (`estimateTokens`). Used to fold a soon-to-be
 * injected `[SYSTEM_INSTRUCTIONS]` block into the budget projection. */
export function estimatePlannerInstructionTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Compute the planner's output-aware compaction budget. Pure, so it unit-tests
 * without the SDK.
 *
 * The compaction floor is driven by the model's *real* generation budget
 * (`maxOutputTokens`) rather than Pi's fixed `reserveTokens` knob (which the
 * extension cannot read): reserving `maxOutputTokens` guarantees there is always
 * room to generate a full response, which is what prevents the
 * "length + output===0" context-overflow variant of the maximum-output stop.
 *
 * Everything is derived from the live `contextWindow` / `maxOutputTokens`, so the
 * math self-adapts across models and windows (correct on 32k and on 1M). The
 * output reserve is clamped so a model reporting `maxTokens ≈ window` cannot drive
 * the floor to zero, and the floor itself is clamped into a sane band.
 *
 * `projected = tokens + pendingInstructionTokens` — folding in an instruction
 * block we are about to inject so a burst does not slip past the check. When
 * `tokens` is unknown (right after a compaction) we cannot evaluate the floor, so
 * `run` is false and the `onError`/watchdog layers remain the backstop.
 *
 * `expectedGrowthTokens` (optional) is the observed EWMA of per-turn growth (see
 * `observeTurnGrowth`). When the projection is still under the floor but *one more*
 * typical turn would cross it, we compact now — pre-empting the mid-turn overflow
 * that the between-turns check would otherwise miss, and adapting the cushion to
 * the session's real growth rate instead of only the fixed tool-headroom ratio.
 */
export function projectPlannerContextBudget(input: {
	tokens: number | null;
	contextWindow: number;
	maxOutputTokens: number;
	pendingInstructionTokens?: number;
	expectedGrowthTokens?: number;
	toolHeadroomRatio: number;
	maxOutputReserveRatio: number;
	minOutputReserve: number;
	minFloorRatio: number;
	maxFloorRatio: number;
}): PlannerContextBudgetDecision {
	const { contextWindow } = input;
	const pending = input.pendingInstructionTokens ?? 0;
	const growth = Math.max(0, input.expectedGrowthTokens ?? 0);

	if (input.tokens === null || contextWindow <= 0) {
		return {
			run: false,
			reason: null,
			floor: 0,
			projected: pending,
			headroom: 0,
		};
	}

	const outputReserve = clamp(
		input.maxOutputTokens,
		input.minOutputReserve,
		contextWindow * input.maxOutputReserveRatio,
	);
	const toolHeadroom = contextWindow * input.toolHeadroomRatio;
	const floor = clamp(
		contextWindow - (outputReserve + toolHeadroom),
		contextWindow * input.minFloorRatio,
		contextWindow * input.maxFloorRatio,
	);

	const projected = input.tokens + pending;
	const headroom = floor - projected;
	// One typical turn ahead would cross the floor: pre-empt while a clean boundary
	// is available. Only meaningful while still under the floor (else output_budget
	// already fires below).
	if (projected <= floor && projected + growth > floor) {
		return { run: true, reason: "growth_margin", floor, projected, headroom };
	}
	if (projected > floor) {
		return { run: true, reason: "output_budget", floor, projected, headroom };
	}
	return { run: false, reason: "below_threshold", floor, projected, headroom };
}

/**
 * Decide whether the `turn_end` monitor should proactively trigger a
 * planner-controlled compaction. Pure, so it unit-tests without the SDK.
 *
 * We compact only when the budget says so, no compaction is already running, and
 * the plan is in a working stage that is not already handling (or blocked on)
 * something else: a pending compact boundary is left to the dedicated compact
 * step, and broken / user-decision states must not be disturbed mid-turn.
 */
export function shouldProactivelyCompact(input: {
	stage: PlannerProactiveStage;
	run: boolean;
	compactionInFlight: boolean;
	requiresCompact: boolean;
	requiresUserDecision: boolean;
	broken: boolean;
}): boolean {
	if (!input.run || input.compactionInFlight) return false;
	if (input.requiresCompact || input.requiresUserDecision || input.broken) {
		return false;
	}
	return PROACTIVE_COMPACT_STAGES.has(input.stage);
}

// Only stages that accumulate meaningful context and are safe to compact between
// turns. `init`/`intake` barely have context; `done`/`recovery` must be left alone.
type PlannerProactiveStage =
	| "init"
	| "intake"
	| "discovery"
	| "spec"
	| "planning"
	| "execution"
	| "finalize"
	| "done"
	| "recovery";

const PROACTIVE_COMPACT_STAGES = new Set<PlannerProactiveStage>([
	"discovery",
	// The spec stage loops (draft → gaps → verify) and accumulates real context.
	"spec",
	"planning",
	"execution",
	"finalize",
]);

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
