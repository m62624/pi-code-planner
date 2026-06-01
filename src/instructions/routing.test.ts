import { describe, expect, it } from "vitest";
import { createProjectStoragePaths } from "../storage/paths";
import type { PlannerStep } from "../storage/schema";
import { createInstructionPaths } from "./paths";
import {
	getInstructionKeysForPlannerStep,
	getInstructionRoutingForState,
} from "./routing";

describe("instruction routing", () => {
	it("maps broad stages to stage and supporting instruction keys", () => {
		expect(keys("init", "check_git")).toEqual(["init", "git"]);
		expect(keys("discovery", "index_files_iteratively")).toEqual([
			"discovery",
			"memory",
		]);
		expect(keys("planning", "draft_plan")).toEqual(["planning", "memory"]);
		expect(keys("finalize", "verify_plan_branch")).toEqual(["finalize", "git"]);
		expect(keys("done", "await_user_acceptance")).toEqual(["done"]);
		expect(keys("recovery", "inspect_git")).toEqual([
			"recovery",
			"git",
			"memory",
		]);
	});

	it("adds tdd, experiment, refactor, and git commit instructions for execution steps", () => {
		expect(keys("execution", "write_tdd_plan")).toEqual([
			"execution",
			"tdd",
			"memory",
		]);
		expect(keys("execution", "run_experiment")).toEqual([
			"execution",
			"experiment",
			"memory",
		]);
		expect(keys("execution", "refactor_task")).toEqual([
			"execution",
			"refactor",
			"memory",
		]);
		expect(keys("execution", "merge_task_to_plan")).toEqual([
			"execution",
			"git",
			"git-commit",
			"memory",
		]);
	});

	it("returns exact default, global append, and project append paths for status output", () => {
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const routing = getInstructionRoutingForState({
			state: {
				stage: "execution",
				step: "write_tests",
			},
			paths: createInstructionPaths(projectPaths),
		});

		expect(routing.keys).toEqual(["execution", "tdd", "memory"]);
		expect(routing.entries[0]).toMatchObject({
			key: "execution",
			defaultPath:
				"/agent/extensions/pi-code-planner/instructions/defaults/execution.md",
			globalAppendPath:
				"/agent/extensions/pi-code-planner/instructions/append/execution.md",
			projectAppendPath:
				"/repo/app/.pi/pi-code-planner/instructions/append/execution.md",
		});
	});
});

function keys(stage: string, step: PlannerStep) {
	return getInstructionKeysForPlannerStep({
		stage: stage as never,
		step,
	});
}
