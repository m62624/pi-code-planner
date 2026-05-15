import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { CompactionCoordinator } from "../compaction/coordinator";
import { checkMemoryPolicy } from "../memory/policy";
import type { DirtyMemoryState } from "../memory/schema";
import type { MemoryDirtyPolicySettings } from "../settings/schema";

export type CompactionCoordinatorResolver = (
	cwd: string,
) => CompactionCoordinator;
export type DirtyMemoryResolver = (
	cwd: string,
) => DirtyMemoryState | Promise<DirtyMemoryState>;
export type MemoryDirtyPolicyResolver = (
	cwd: string,
) => MemoryDirtyPolicySettings;

function ok<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function fail<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

async function requestCompact(
	ctx: ExtensionContext,
	getCompactor: CompactionCoordinatorResolver,
	getDirtyMemory: DirtyMemoryResolver | undefined,
	getMemoryDirtyPolicy: MemoryDirtyPolicyResolver | undefined,
	params: Static<typeof requestCompactSchema>,
): Promise<AgentToolResult<unknown>> {
	const dirty = getDirtyMemory ? await getDirtyMemory(ctx.cwd) : null;
	if (dirty && (getMemoryDirtyPolicy?.(ctx.cwd).blockCompact ?? true)) {
		const memoryPolicy = checkMemoryPolicy({
			operation: "request_compact",
			dirty,
		});
		if (memoryPolicy.kind === "block") {
			return fail(memoryPolicy.message, { memoryPolicy });
		}
	}

	const result = getCompactor(ctx.cwd).requestCompact(ctx, params);
	if (result.kind === "already_pending") {
		return ok("Planner compaction is already pending.", result);
	}
	return ok("Planner compaction requested.", result);
}

const compactReasonSchema = Type.Union([
	Type.Literal("discovery"),
	Type.Literal("work_item"),
	Type.Literal("refactor"),
	Type.Literal("manual"),
]);

const requestCompactSchema = Type.Object({
	reason: compactReasonSchema,
	customInstructions: Type.String({
		description: "Instructions passed to Pi compaction.",
	}),
	resumePrompt: Type.String({
		description:
			"Planner instruction delivered after compaction without displacing queued user input.",
	}),
	activePlanId: Type.Optional(Type.String({ description: "Active plan id." })),
	activeWorkItemId: Type.Optional(
		Type.String({ description: "Active work item id." }),
	),
	attachToNextTurn: Type.Optional(
		Type.Boolean({
			description:
				"Attach resume prompt to the next real user turn when possible.",
		}),
	),
	autoResume: Type.Optional(
		Type.Boolean({
			description: "Send resume prompt automatically if no user turn appears.",
		}),
	),
});

export function createPlannerCompactionTools(
	getCompactor: CompactionCoordinatorResolver,
	getDirtyMemory?: DirtyMemoryResolver,
	getMemoryDirtyPolicy?: MemoryDirtyPolicyResolver,
): ToolDefinition[] {
	return [
		{
			name: "planner_request_compact",
			label: "planner compact",
			description:
				"Request planner-controlled context compaction and schedule a safe resume instruction.",
			promptSnippet:
				"CALL only at planner compact boundary stages. Schedules Pi compaction and a safe resume instruction without bypassing queued user input.",
			parameters: requestCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof requestCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				requestCompact(
					ctx,
					getCompactor,
					getDirtyMemory,
					getMemoryDirtyPolicy,
					params,
				),
		},
	];
}
