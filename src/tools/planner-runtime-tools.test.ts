import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { PlannerRuntimeController } from "../runtime/planner-runtime-controller";
import { createPlannerRuntimeTools } from "./planner-runtime-tools";

function context(): ExtensionContext {
	return {
		cwd: "/repo",
	} as unknown as ExtensionContext;
}

describe("createPlannerRuntimeTools", () => {
	it("registers the runtime status tool", () => {
		const tools = createPlannerRuntimeTools(
			() => ({}) as PlannerRuntimeController,
		);

		expect(tools.map((tool) => tool.name)).toEqual(["planner_runtime_status"]);
		expect(tools[0].promptGuidelines?.length).toBeGreaterThan(0);
	});

	it("returns inspection details and appends next prompt when present", async () => {
		const inspect = vi.fn().mockResolvedValue({
			status: "ready",
			message: "Planner is ready at plan stage: discovery_full.",
			nextPrompt: {
				prompt: "Continue discovery.",
				instruction: "Continue discovery.",
				artifactPaths: ["/plan.md"],
			},
		});
		const controller = { inspect } as unknown as PlannerRuntimeController;
		const tool = createPlannerRuntimeTools(() => controller)[0];

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(inspect).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain(
			"Planner is ready at plan stage: discovery_full.",
		);
		expect(result.content[0].text).toContain("NEXT PLANNER INSTRUCTION");
		expect(result.content[0].text).toContain("Continue discovery.");
		expect(result.details).toMatchObject({
			status: "ready",
			nextPrompt: {
				prompt: "Continue discovery.",
			},
		});
	});

	it("does not append a next prompt when runtime is blocked", async () => {
		const inspect = vi.fn().mockResolvedValue({
			status: "recovery_required",
			message: "Git repository is missing.",
			nextPrompt: null,
		});
		const controller = { inspect } as unknown as PlannerRuntimeController;
		const tool = createPlannerRuntimeTools(() => controller)[0];

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(result.content[0].text).toBe("Git repository is missing.");
		expect(result.details).toMatchObject({
			status: "recovery_required",
			nextPrompt: null,
		});
	});
});
