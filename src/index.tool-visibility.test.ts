import { beforeEach, describe, expect, it } from "vitest";
import {
	ALL_PLANNER_TOOL_NAMES,
	PLANNER_WRAPPER_TOOLS,
} from "./guard/tool-policy";
import {
	activatePlannerToolVisibility,
	filterPlannerTools,
	persistPlannerToolVisibilityActive,
	persistPlannerToolVisibilityActiveToSession,
	type RegisteredTool,
	registerPlannerToolVisibility,
	setPlanActive,
	updateToolVisibility,
} from "./index.tool-visibility";
import type { PlannerFs } from "./storage/fs";

describe("filterPlannerTools", () => {
	let mockTools: RegisteredTool[];

	beforeEach(() => {
		mockTools = [
			{ name: "bash" },
			{ name: "read" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "planner_status" },
			{ name: "planner_create_plan" },
			{ name: "planner_goal_submit" },
			{ name: "planner_goal_decide" },
			{ name: "planner_questions_submit" },
			{ name: "planner_questions_resolve" },
			{ name: "planner_task_upsert" },
			{ name: "planner_git_inspect" },
			{ name: "planner_git_init" },
			{ name: "planner_git_commit" },
			{ name: "planner_git_create_task_branch" },
			{ name: "planner_git_create_experiment_branch" },
			{ name: "planner_git_select_experiment" },
			{ name: "planner_git_merge_selected_experiment" },
			{ name: "planner_git_create_refactor_branch" },
			{ name: "planner_git_merge_refactor_to_task" },
			{ name: "planner_git_merge_task_to_plan" },
			{ name: "planner_recovery_inspect" },
			{ name: "planner_recovery_resume" },
			{ name: "planner_start_step" },
			{ name: "planner_finish_step" },
			{ name: "planner_advance_step" },
			{ name: "planner_fail_step" },
			{ name: "planner_block_step" },
			{ name: "planner_retry_step" },
			{ name: "planner_request_compact" },
			{ name: "planner_complete_compact" },
			{ name: "planner_enter_recovery" },
			{ name: "planner_resume_after_recovery" },
		];
	});

	it("filters out ALL planner tools including workflow tools", () => {
		const result = filterPlannerTools(mockTools);

		const toolNames = result.map((t) => t.name);
		for (const plannerTool of ALL_PLANNER_TOOL_NAMES) {
			expect(toolNames).not.toContain(plannerTool);
		}
	});

	it("keeps non-planner tools", () => {
		const result = filterPlannerTools(mockTools);

		const toolNames = result.map((t) => t.name);
		expect(toolNames).toContain("bash");
		expect(toolNames).toContain("read");
		expect(toolNames).toContain("write");
		expect(toolNames).toContain("edit");
	});

	it("returns empty array when all tools are planner tools", () => {
		const plannerOnlyTools: RegisteredTool[] = ALL_PLANNER_TOOL_NAMES.map(
			(name) => ({ name }),
		);

		const result = filterPlannerTools(plannerOnlyTools);

		expect(result).toHaveLength(0);
	});

	it("returns all tools unchanged when no planner tools in input", () => {
		const nonPlannerTools: RegisteredTool[] = [
			{ name: "bash" },
			{ name: "read" },
			{ name: "write" },
		];

		const result = filterPlannerTools(nonPlannerTools);

		expect(result).toEqual(nonPlannerTools);
	});

	it("preserves tool names as strings", () => {
		const result = filterPlannerTools(mockTools);

		const toolNames = result.map((t) => t.name);
		expect(toolNames.every((n) => typeof n === "string")).toBe(true);
	});

	it("removes workflow tools that are not in PLANNER_WRAPPER_TOOLS", () => {
		const workflowTools: RegisteredTool[] = [
			{ name: "bash" },
			{ name: "planner_start_step" },
			{ name: "planner_finish_step" },
			{ name: "planner_advance_step" },
			{ name: "planner_fail_step" },
			{ name: "planner_block_step" },
			{ name: "planner_retry_step" },
			{ name: "planner_request_compact" },
			{ name: "planner_complete_compact" },
			{ name: "planner_enter_recovery" },
			{ name: "planner_resume_after_recovery" },
		];

		const result = filterPlannerTools(workflowTools);

		const toolNames = result.map((t) => t.name);
		expect(toolNames).toEqual(["bash"]);
	});

	it("ALL_PLANNER_TOOL_NAMES is a superset of PLANNER_WRAPPER_TOOLS", () => {
		for (const wrapperTool of PLANNER_WRAPPER_TOOLS) {
			expect(ALL_PLANNER_TOOL_NAMES).toContain(wrapperTool);
		}
	});

	it("ALL_PLANNER_TOOL_NAMES has exactly 29 tools", () => {
		expect(ALL_PLANNER_TOOL_NAMES).toHaveLength(29);
	});
});

describe("updateToolVisibility", () => {
	let mockTools: RegisteredTool[];

	beforeEach(() => {
		setPlanActive(false);
		mockTools = [
			{ name: "bash" },
			{ name: "planner_status" },
			{ name: "planner_create_plan" },
		];
	});

	it("sets active tools on the pi instance", () => {
		const activeTools: string[][] = [];
		const mockPi = {
			getAllTools: () => mockTools,
			setActiveTools: (names: string[]) => {
				activeTools.push(names);
			},
		} as unknown as ExtensionAPI;

		updateToolVisibility(mockPi);
		expect(activeTools).toHaveLength(1);
		expect(activeTools[0]).toEqual(["bash"]);
	});

	it("shows all tools after explicit planner activation", () => {
		const activeTools: string[][] = [];
		const mockPi = {
			getAllTools: () => mockTools,
			setActiveTools: (names: string[]) => {
				activeTools.push(names);
			},
		} as unknown as ExtensionAPI;

		activatePlannerToolVisibility(mockPi);

		expect(activeTools).toEqual([
			["bash", "planner_status", "planner_create_plan"],
		]);
	});

	it("does not hide planner tools on session_start after explicit activation", async () => {
		const activeTools: string[][] = [];
		const handlers: Record<string, () => Promise<void>> = {};
		const mockPi = {
			getAllTools: () => mockTools,
			setActiveTools: (names: string[]) => {
				activeTools.push(names);
			},
			on: (event: string, handler: () => Promise<void>) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;

		registerPlannerToolVisibility(mockPi);
		activatePlannerToolVisibility(mockPi);
		await handlers.session_start();

		expect(activeTools).toEqual([
			["bash", "planner_status", "planner_create_plan"],
			["bash", "planner_status", "planner_create_plan"],
		]);
	});

	it("restores planner tools from the session visibility marker", async () => {
		const activeTools: string[][] = [];
		const entries: unknown[] = [];
		const handlers: Record<
			string,
			(_event?: unknown, ctx?: unknown) => Promise<void>
		> = {};
		const mockPi = {
			getAllTools: () => mockTools,
			setActiveTools: (names: string[]) => {
				activeTools.push(names);
			},
			appendEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data });
			},
			on: (event: string, handler: () => Promise<void>) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;
		const mockCtx = {
			sessionManager: {
				getBranch: () => entries,
			},
		};

		persistPlannerToolVisibilityActive(mockPi);
		setPlanActive(false);
		registerPlannerToolVisibility(mockPi);
		await handlers.session_start(undefined, mockCtx);

		expect(activeTools.at(-1)).toEqual([
			"bash",
			"planner_status",
			"planner_create_plan",
		]);
	});

	it("persists planner tool visibility directly to a handoff session file", async () => {
		let content = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-06-04T00:00:00.000Z",
			cwd: "/repo/worktree",
		})}\n`;
		const fs = {
			readText: async () => content,
			writeTextAtomic: async (_path: string, next: string) => {
				content = next;
			},
		} as PlannerFs;

		await persistPlannerToolVisibilityActiveToSession({
			fs,
			sessionFile: "/sessions/plan.jsonl",
			now: new Date("2026-06-04T01:00:00.000Z"),
			id: "planner-tools-test",
		});

		const lines = content.trim().split("\n").map(JSON.parse);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatchObject({
			type: "custom",
			customType: "planner-tool-visibility",
			data: { active: true },
			id: "planner-tools-test",
			parentId: null,
		});
	});
});
