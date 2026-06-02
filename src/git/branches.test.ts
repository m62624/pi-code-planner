import { describe, expect, it } from "vitest";
import {
	experimentBranchName,
	outputBranchName,
	planBranchName,
	refactorBranchName,
	taskBranchName,
} from "./branches";

describe("planner branch names", () => {
	it("builds stable sanitized branch names from ids", () => {
		expect(planBranchName("Plan A")).toBe("plan/plan-a");
		expect(taskBranchName("Plan A", "Task 1")).toBe("task/plan-a/task-1");
		expect(experimentBranchName("Plan A", "Task 1", "Attempt 2")).toBe(
			"experiment/plan-a/task-1/attempt-2",
		);
		expect(refactorBranchName("Plan A", "Task 1")).toBe(
			"refactor/plan-a/task-1",
		);
		expect(outputBranchName("Plan A")).toBe("output/plan-a");
	});

	it("replaces dots with hyphens", () => {
		expect(planBranchName("watcher-json.timer.tools")).toBe(
			"plan/watcher-json-timer-tools",
		);
		expect(
			experimentBranchName(
				"watcher-json.timer",
				"llaner-status.-10.to",
				"attempt",
			),
		).toBe("experiment/watcher-json-timer/llaner-status-10-to/attempt");
	});

	it("handles mixed special characters", () => {
		expect(planBranchName("Plan.v2 (draft)!")).toBe("plan/plan-v2-draft");
	});
});
