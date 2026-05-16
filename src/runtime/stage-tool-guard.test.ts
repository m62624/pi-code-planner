import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { PlannerRuntimeInspection } from "./planner-runtime-controller";
import { checkPlannerStageToolCall } from "./stage-tool-guard";

function inspection(
	overrides: Partial<PlannerRuntimeInspection>,
): PlannerRuntimeInspection {
	return {
		status: "ready",
		message: "ready",
		state: {} as PlannerRuntimeInspection["state"],
		repo: {} as PlannerRuntimeInspection["repo"],
		recovery: {
			status: "ok",
			requiresRecovery: false,
			message: "ok",
			currentBranch: null,
			expectedBranch: null,
		},
		memory: {
			dirty: { files: {} },
			hasDirtyFiles: false,
		},
		decision: {} as PlannerRuntimeInspection["decision"],
		plan: null,
		workItem: null,
		nextPrompt: null,
		...overrides,
	};
}

function planStage(stage: string): PlannerRuntimeInspection {
	return inspection({
		plan: {
			version: 1,
			projectKey: "project",
			planId: "plan-1",
			title: "Plan",
			stage,
			status: "draft",
			createdAt: "",
			updatedAt: "",
		} as PlannerRuntimeInspection["plan"],
	});
}

function workItemStage(stage: string): PlannerRuntimeInspection {
	return inspection({
		plan: {
			version: 1,
			projectKey: "project",
			planId: "plan-1",
			title: "Plan",
			stage: "plan_active",
			status: "draft",
			createdAt: "",
			updatedAt: "",
		} as PlannerRuntimeInspection["plan"],
		workItem: {
			version: 1,
			planId: "plan-1",
			workItemId: "item-1",
			title: "Item",
			stage,
			status: "ready",
			createdAt: "",
			updatedAt: "",
		} as PlannerRuntimeInspection["workItem"],
	});
}

function guard(
	input: Partial<{
		inspection: PlannerRuntimeInspection;
		toolName: string;
		input: Record<string, unknown>;
	}>,
): ToolCallEventResult | undefined {
	return checkPlannerStageToolCall({
		inspection: input.inspection ?? planStage("plan_draft"),
		toolName: input.toolName ?? "read",
		input: input.input ?? {},
		artifactsRoot: "/agent/extensions/pi-planner",
	});
}

describe("checkPlannerStageToolCall", () => {
	it("blocks project inspection in plan_draft until discovery starts", () => {
		const result = guard({
			inspection: planStage("plan_draft"),
			toolName: "read",
			input: { path: "/repo/package.json" },
		});

		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain("Transition the plan to discovery_full");
	});

	it("allows transitioning the plan out of plan_draft", () => {
		const result = guard({
			inspection: planStage("plan_draft"),
			toolName: "planner_transition_plan",
			input: { planId: "plan-1", stage: "discovery_full" },
		});

		expect(result).toBeUndefined();
	});

	it("blocks memory mutation in plan_draft", () => {
		const result = guard({
			inspection: planStage("plan_draft"),
			toolName: "planner_memory_upsert_files",
		});

		expect(result).toMatchObject({ block: true });
	});

	it("allows discovery to write planner artifacts but blocks project edits", () => {
		expect(
			guard({
				inspection: planStage("discovery_full"),
				toolName: "write",
				input: {
					path: "/agent/extensions/pi-planner/projects/repo/plans/plan-1/discovery.md",
				},
			}),
		).toBeUndefined();

		const projectWrite = guard({
			inspection: planStage("discovery_full"),
			toolName: "write",
			input: { path: "/repo/src/index.ts" },
		});
		expect(projectWrite).toMatchObject({ block: true });
	});

	it("allows work item creation only during todo_planning", () => {
		expect(
			guard({
				inspection: planStage("todo_planning"),
				toolName: "planner_create_work_item",
			}),
		).toBeUndefined();

		const result = guard({
			inspection: planStage("discovery_full"),
			toolName: "planner_create_work_item",
		});
		expect(result).toMatchObject({ block: true });
	});

	it("blocks plan-level skeleton writes to project files", () => {
		const result = guard({
			inspection: planStage("skeleton_write"),
			toolName: "edit",
			input: { path: "/repo/src/index.ts" },
		});

		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain("Project code edits are blocked");
	});

	it("blocks implementation tools at a ready work item", () => {
		const result = guard({
			inspection: workItemStage("ready"),
			toolName: "write",
			input: { path: "/repo/src/index.ts" },
		});

		expect(result).toMatchObject({ block: true });
	});

	it("blocks production edits before the TDD stages allow them", () => {
		expect(
			guard({
				inspection: workItemStage("active"),
				toolName: "edit",
				input: { path: "/repo/src/config.ts" },
			}),
		).toMatchObject({ block: true });

		expect(
			guard({
				inspection: workItemStage("tdd_prepare"),
				toolName: "write",
				input: { path: "/repo/src/config.ts" },
			}),
		).toMatchObject({ block: true });
	});

	it("allows shell inspection while preparing the TDD plan", () => {
		expect(
			guard({
				inspection: workItemStage("tdd_prepare"),
				toolName: "bash",
				input: { command: "git diff --stat HEAD" },
			}),
		).toBeUndefined();
	});

	it("allows only test file writes in tdd_write_tests", () => {
		expect(
			guard({
				inspection: workItemStage("tdd_write_tests"),
				toolName: "edit",
				input: { path: "/repo/src/config.test.ts" },
			}),
		).toBeUndefined();

		expect(
			guard({
				inspection: workItemStage("tdd_write_tests"),
				toolName: "edit",
				input: { path: "/repo/src/config.ts" },
			}),
		).toMatchObject({ block: true });
	});

	it("limits dirty memory recovery to memory refresh tools and reads", () => {
		const dirty = inspection({
			status: "memory_refresh_required",
			memory: {
				dirty: {
					files: {
						"src/app.ts": {
							filePath: "src/app.ts",
							reason: "git status changed",
							markedAt: "",
						},
					},
				},
				hasDirtyFiles: true,
			},
		});

		expect(
			guard({ inspection: dirty, toolName: "planner_memory_get_dirty" }),
		).toBeUndefined();
		expect(guard({ inspection: dirty, toolName: "bash" })).toMatchObject({
			block: true,
		});
	});
});
