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
export const PLANNER_SYSTEM_INSTRUCTIONS_HEADER =
	"[PI-CODE-PLANNER SYSTEM INSTRUCTIONS]";

export interface PlannerCompactRuntimeState {
	plannerControlledCompactInFlight: boolean;
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

export function createPlannerCompactRuntimeState(): PlannerCompactRuntimeState {
	return { plannerControlledCompactInFlight: false };
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
		"Preserve planner state, artifact paths, git/memory gates, completed work, open risks, and the exact next required planner action.",
		"Preserve memory indexing mode, active indexing file, and exact next unread line when a durable indexing queue is in progress.",
		"Do not mark any planner step complete unless state.json already says it is complete.",
		"After compaction, continuation must call planner_status before choosing any next action.",
		"",
		"## Planner State",
		`- planId: ${planId ?? "(none)"}`,
		`- stage: ${state?.stage ?? "(none)"}`,
		`- step: ${state?.step ?? "(none)"}`,
		`- stepStatus: ${state?.stepStatus ?? "(none)"}`,
		`- activeTaskId: ${state?.activeTaskId ?? "(none)"}`,
		`- activeExperimentId: ${state?.activeExperimentId ?? "(none)"}`,
		`- currentBranch: ${state?.currentBranch ?? "(none)"}`,
		`- lastCheckpointCommit: ${state?.lastCheckpointCommit ?? "(none)"}`,
		`- requiresMemoryUpdate: ${String(state?.requiresMemoryUpdate ?? false)}`,
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

export function buildPlannerPostAutoCompactMessage(input: {
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
		"Pi auto-compaction or an unplanned compaction has completed while pi-code-planner is active.",
		"Do not continue from memory or from the previous chat state.",
		"Call planner_status now and follow the exact reported stage, step, allowed wrappers, memory gate, and recovery gate.",
		"If planner_status reports stale memory, update planner memory before continuing.",
		"If planner_status reports an active memory indexing file, resume that file from activeIndexNextUnreadLine. Do not reread completed files or claim another file.",
		"If planner_status reports recovery, use recovery tools and ask the user before destructive repair.",
		"Do not use raw git. Use planner git wrappers only.",
		"",
		"## Current Stored Position",
		`- planId: ${planId ?? "(none)"}`,
		`- stage: ${state?.stage ?? "(none)"}`,
		`- step: ${state?.step ?? "(none)"}`,
		`- stepStatus: ${state?.stepStatus ?? "(none)"}`,
		`- activeTaskId: ${state?.activeTaskId ?? "(none)"}`,
		`- activeExperimentId: ${state?.activeExperimentId ?? "(none)"}`,
		"",
		"## Auto-Compact Instruction Sections",
		...sectionLines(input.sections),
	].join("\n");
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
		`- tasksDir: ${planPaths.tasksDir}`,
	];
	if (preflight.memoryPaths) {
		lines.push(
			`- memoryDir: ${preflight.memoryPaths.memoryDir}`,
			`- memory files: ${preflight.memoryPaths.filesIndexJsonl}`,
			`- memory symbols: ${preflight.memoryPaths.symbolsIndexJsonl}`,
			`- memory relations: ${preflight.memoryPaths.relationsIndexJsonl}`,
			`- memory indexing progress: ${preflight.memoryPaths.indexingJson}`,
		);
	}
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
