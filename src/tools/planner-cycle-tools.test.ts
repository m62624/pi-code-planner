import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { PlannerCycleManager } from "../cycle/manager";
import { createPlannerCycleTools } from "./planner-cycle-tools";

function context(): ExtensionContext {
	return {
		cwd: "/repo",
	} as unknown as ExtensionContext;
}

describe("createPlannerCycleTools", () => {
	it("registers planner_next_step", () => {
		const tools = createPlannerCycleTools(
			() => ({}) as unknown as PlannerCycleManager,
		);

		expect(tools.map((tool) => tool.name)).toEqual(["planner_next_step"]);
		expect(tools[0].promptGuidelines?.length).toBeGreaterThan(0);
	});

	it("returns normalized next step and appends prompt when present", async () => {
		const getNextStep = vi.fn().mockResolvedValue({
			status: "ready",
			kind: "plan_stage",
			blocking: false,
			message: "Planner is ready.",
			requiredTool: null,
			prompt: {
				prompt: "Continue discovery.",
				instruction: "Discovery instruction",
				artifactPaths: ["/plan.md"],
			},
		});
		const manager = { getNextStep } as unknown as PlannerCycleManager;
		const tool = createPlannerCycleTools(() => manager)[0];

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(getNextStep).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("Planner is ready.");
		expect(result.content[0].text).toContain("NEXT PLANNER INSTRUCTION");
		expect(result.content[0].text).toContain("Continue discovery.");
		expect(result.details).toMatchObject({
			status: "ready",
			kind: "plan_stage",
			requiredTool: null,
		});
	});

	it("returns blocked next step without prompt text", async () => {
		const getNextStep = vi.fn().mockResolvedValue({
			status: "blocked",
			kind: "compact_required",
			blocking: true,
			message: "Discovery compact is required.",
			requiredTool: "planner_request_discovery_compact",
			prompt: null,
		});
		const manager = { getNextStep } as unknown as PlannerCycleManager;
		const tool = createPlannerCycleTools(() => manager)[0];

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(result.content[0].text).toBe("Discovery compact is required.");
		expect(result.details).toMatchObject({
			status: "blocked",
			kind: "compact_required",
			requiredTool: "planner_request_discovery_compact",
		});
	});
});
