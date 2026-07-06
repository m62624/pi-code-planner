import { describe, expect, it } from "vitest";
import { appliedResult, blockedResult } from "./tool-result";

describe("tool-result factories", () => {
	it("blockedResult builds the shared shape with a literal status", () => {
		const result = blockedResult("planner_task_upsert", "nope");
		expect(result).toEqual({
			status: "blocked",
			toolName: "planner_task_upsert",
			text: "nope",
			details: null,
		});
		// Literal status narrows (compile-time guard, asserted at runtime too).
		expect(result.status).toBe("blocked");
	});

	it("appliedResult carries a typed details payload through", () => {
		const details = { path: "/x/task.json" };
		const result = appliedResult("planner_task_upsert", "done", details);
		expect(result).toEqual({
			status: "applied",
			toolName: "planner_task_upsert",
			text: "done",
			details,
		});
		expect(result.details).toBe(details);
	});
});
