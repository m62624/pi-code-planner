import { isAbsolute, relative, resolve } from "node:path";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PlannerRuntimeInspection } from "./planner-runtime-controller";

const ALWAYS_ALLOWED_PLANNER_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
]);

const RECOVERY_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_initialize_repo",
	"planner_accept_current_git_state",
	"planner_soft_reset_to_expected",
	"planner_hard_reset_to_expected",
]);

const PLAN_DRAFT_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_start_plan",
	"planner_initialize_repo",
	"planner_transition_plan",
]);

const DISCOVERY_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_start_plan",
	"planner_transition_plan",
	"planner_request_discovery_compact",
	"planner_complete_discovery_compact",
]);

const TODO_PLANNING_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_transition_plan",
	"planner_create_work_item",
]);

const PLAN_ARTIFACT_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_transition_plan",
]);

const PLAN_READY_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_transition_plan",
	"planner_transition_work_item",
	"planner_start_work_item",
]);

const MEMORY_REFRESH_TOOLS = new Set([
	"planner_runtime_status",
	"planner_next_step",
	"planner_memory_status",
	"planner_memory_get_dirty",
	"planner_memory_upsert_files",
	"planner_memory_upsert_symbols",
	"planner_memory_upsert_relations",
	"planner_memory_verify_file",
	"planner_memory_verify_symbol",
	"planner_memory_clear_dirty",
	"planner_memory_delete_symbol",
	"planner_memory_delete_relation",
	"planner_transition_work_item",
]);

const PLANNER_ARTIFACT_WRITE_STAGES = new Set([
	"discovery_full",
	"post_discovery_questions",
	"todo_planning",
	"skeleton_planning",
	"skeleton_write",
	"stub_audit",
]);

export interface StageToolGuardInput {
	inspection: PlannerRuntimeInspection;
	toolName: string;
	input: Record<string, unknown>;
	artifactsRoot: string;
}

function block(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

function isPlannerTool(toolName: string): boolean {
	return toolName.startsWith("planner_");
}

function isMemoryTool(toolName: string): boolean {
	return toolName.startsWith("planner_memory_");
}

function isReadOnlyProjectTool(toolName: string): boolean {
	return toolName === "read" || toolName === "ls" || toolName === "grep";
}

function isWriteTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

function isTestPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").toLowerCase();
	return (
		normalized.includes(".test.") ||
		normalized.includes(".spec.") ||
		normalized.includes("/__tests__/") ||
		normalized.endsWith("_test.go") ||
		normalized.endsWith("_test.rs") ||
		normalized.endsWith("_test.py") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/")
	);
}

function toolPath(input: Record<string, unknown>): string | null {
	const path = input.path;
	return typeof path === "string" ? path : null;
}

function isInside(parent: string, child: string): boolean {
	const resolvedParent = resolve(parent);
	const resolvedChild = resolve(child);
	const rel = relative(resolvedParent, resolvedChild);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isPlannerArtifactPath(input: StageToolGuardInput): boolean {
	const path = toolPath(input.input);
	return path ? isInside(input.artifactsRoot, path) : false;
}

function isTestFileWrite(input: StageToolGuardInput): boolean {
	const path = toolPath(input.input);
	return path ? isTestPath(path) : false;
}

function allowPlannerTool(
	allowed: Set<string>,
	toolName: string,
	stage: string,
): ToolCallEventResult | undefined {
	if (allowed.has(toolName)) return undefined;
	if (ALWAYS_ALLOWED_PLANNER_TOOLS.has(toolName)) return undefined;
	return block(
		`Planner stage ${stage} does not allow ${toolName}. Call planner_next_step and use only the tool required for this stage.`,
	);
}

function guardPlanStage(
	input: StageToolGuardInput,
	stage: string,
): ToolCallEventResult | undefined {
	const toolName = input.toolName;

	if (stage === "plan_draft") {
		if (isPlannerTool(toolName)) {
			return allowPlannerTool(PLAN_DRAFT_TOOLS, toolName, stage);
		}
		return block(
			"Plan is in plan_draft. Do not inspect or edit project files yet. Transition the plan to discovery_full first.",
		);
	}

	if (stage === "discovery_full") {
		if (isMemoryTool(toolName)) return undefined;
		if (isPlannerTool(toolName)) {
			return allowPlannerTool(DISCOVERY_TOOLS, toolName, stage);
		}
		if (isReadOnlyProjectTool(toolName) || toolName === "bash")
			return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			"Discovery allows reading project context and writing planner artifacts only. Production edits are blocked until a work item stage.",
		);
	}

	if (stage === "todo_planning") {
		if (isMemoryTool(toolName)) return undefined;
		if (isPlannerTool(toolName)) {
			return allowPlannerTool(TODO_PLANNING_TOOLS, toolName, stage);
		}
		if (isReadOnlyProjectTool(toolName)) return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			"todo_planning allows planner artifacts and planner_create_work_item only. Do not edit project code.",
		);
	}

	if (PLANNER_ARTIFACT_WRITE_STAGES.has(stage)) {
		if (isMemoryTool(toolName)) return undefined;
		if (isPlannerTool(toolName)) {
			return allowPlannerTool(PLAN_ARTIFACT_TOOLS, toolName, stage);
		}
		if (isReadOnlyProjectTool(toolName)) return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			`${stage} is plan-level work. Project code edits are blocked; write only planner artifacts until a work item is active.`,
		);
	}

	if (stage === "plan_ready" || stage === "plan_active") {
		if (isMemoryTool(toolName)) return undefined;
		if (isPlannerTool(toolName)) {
			return allowPlannerTool(PLAN_READY_TOOLS, toolName, stage);
		}
		if (isReadOnlyProjectTool(toolName)) return undefined;
		return block(
			`${stage} requires selecting or starting a work item before editing project files.`,
		);
	}

	return undefined;
}

function guardWorkItemStage(
	input: StageToolGuardInput,
	stage: string,
): ToolCallEventResult | undefined {
	const toolName = input.toolName;

	if (
		stage === "pending" ||
		stage === "ready" ||
		stage === "work_item_compact_required" ||
		stage === "completed" ||
		stage === "skipped"
	) {
		if (isPlannerTool(toolName)) return undefined;
		if (isReadOnlyProjectTool(toolName)) return undefined;
		return block(
			`Work item stage ${stage} is not an implementation stage. Use planner workflow tools before editing project files.`,
		);
	}

	if (stage === "active") {
		if (isPlannerTool(toolName)) return undefined;
		if (isReadOnlyProjectTool(toolName)) return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			"Work item active stage is for loading focused context and moving to tdd_prepare. Write tests before production code.",
		);
	}

	if (stage === "tdd_prepare") {
		if (isPlannerTool(toolName)) return undefined;
		if (isReadOnlyProjectTool(toolName) || toolName === "bash")
			return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			"tdd_prepare allows the TDD plan artifact and read-only inspection only. Move to tdd_write_tests before writing tests.",
		);
	}

	if (stage === "tdd_write_tests") {
		if (isPlannerTool(toolName)) return undefined;
		if (isReadOnlyProjectTool(toolName) || toolName === "bash")
			return undefined;
		if (isWriteTool(toolName) && isTestFileWrite(input)) return undefined;
		if (isWriteTool(toolName) && isPlannerArtifactPath(input)) return undefined;
		return block(
			"tdd_write_tests allows test files only. Production code edits are blocked until tests are written and committed.",
		);
	}

	if (stage === "signature_refresh") {
		if (MEMORY_REFRESH_TOOLS.has(toolName)) return undefined;
		if (isReadOnlyProjectTool(toolName)) return undefined;
		return block(
			"signature_refresh allows memory refresh tools and read-only inspection only. Do not edit project files or run shell commands.",
		);
	}

	return undefined;
}

export function checkPlannerStageToolCall(
	input: StageToolGuardInput,
): ToolCallEventResult | undefined {
	const { inspection, toolName } = input;

	if (inspection.status === "idle") return undefined;

	if (inspection.status === "recovery_required") {
		return RECOVERY_TOOLS.has(toolName)
			? undefined
			: block(
					`Planner recovery is required (${inspection.recovery.status}). Only recovery tools are allowed before normal work continues.`,
				);
	}

	if (inspection.status === "memory_refresh_required") {
		if (MEMORY_REFRESH_TOOLS.has(toolName)) return undefined;
		if (toolName === "bash") {
			return undefined;
		}
		if (isReadOnlyProjectTool(toolName)) return undefined;
		return block(
			"Project memory is dirty. Refresh it before continuing: 1) Call planner_memory_get_dirty to see which files changed. 2) For each dirty file, call read to get the current content. 3) Call planner_memory_upsert_files with the updated file entries. 4) Call planner_memory_upsert_symbols for all exported functions, types, and classes in those files. 5) Call planner_memory_upsert_relations for calls, implements, and other relationships. 6) Call planner_memory_clear_dirty with the updated file paths. Bash is allowed for git status and test verification.",
		);
	}

	if (inspection.workItem) {
		return guardWorkItemStage(input, inspection.workItem.stage);
	}

	if (inspection.plan) {
		return guardPlanStage(input, inspection.plan.stage);
	}

	return undefined;
}
