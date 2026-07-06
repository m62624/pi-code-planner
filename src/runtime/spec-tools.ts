import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	type SpecRecordInput,
	validateSpecRecord,
	writeSpecArtifacts,
} from "../storage/spec-store";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { blockedResult } from "./tool-result";

export const PLANNER_SPEC_TOOL_NAME = "planner_spec_submit" as const;
export type PlannerSpecToolName = typeof PLANNER_SPEC_TOOL_NAME;

/**
 * Persist the structured SDD spec (SPEC.md §5.1). The model authors this
 * record — never the gate VRF (REQ-12): validation happens here with
 * self-contained messages, and the deterministic compiler in
 * planner_gate_check turns the persisted record into the engine program.
 */
export async function executePlannerSpecTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	params: unknown;
}) {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: PLANNER_SPEC_TOOL_NAME,
	});
	if (!policy.allow) {
		return blocked(
			policy.reason ?? "planner_spec_submit is blocked by planner state.",
		);
	}
	try {
		const record = validateSpecRecord(input.params as SpecRecordInput);
		const { planPaths } = orchestrator.preflight.context;
		// Requirement diffs must never silently drop history (REQ-10): the
		// previous version is kept as spec.prev.json so a change request can be
		// audited against what the spec said before the amendment.
		if (await input.fs.exists(planPaths.specJson)) {
			await input.fs.writeTextAtomic(
				planPaths.specPrevJson,
				await input.fs.readText(planPaths.specJson),
			);
		}
		await writeSpecArtifacts(input.fs, planPaths, record);
		const formalized = record.requirements.filter(
			(req) => req.acceptanceAtom !== undefined,
		).length;
		const deferred = record.requirements.filter(
			(req) => req.deferral !== undefined,
		).length;
		return {
			status: "applied" as const,
			toolName: PLANNER_SPEC_TOOL_NAME,
			text: [
				"Planner spec written.",
				`Spec JSON: ${planPaths.specJson}`,
				`Spec Markdown: ${planPaths.specMd}`,
				"",
				`Requirements: ${record.requirements.length} (${formalized} formalized, ${deferred} deferred to human judgment), non-goals: ${record.nonGoals.length}, constraints: ${record.constraints.length}, assumptions: ${record.assumptions.length}.`,
				"",
				await input.fs.readText(planPaths.specMd),
				"",
				"Any earlier spec_consistency gate pass is now stale — re-run planner_gate_check at spec/verify_spec before advancing.",
				"Call planner_status before choosing the next planner action.",
			].join("\n"),
			details: { record },
		};
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

function blocked(text: string) {
	return blockedResult(PLANNER_SPEC_TOOL_NAME, text);
}
