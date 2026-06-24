import { describe, expect, it } from "vitest";
import { gitToolParameters } from "./index";
import type { PlannerGitToolName } from "./runtime/git-tools";

// The commit/merge message is written by the model, so the language reminder
// must live on the tool parameter itself — the instruction file alone is not
// reliably in context at commit time. Guard against the description silently
// going missing again.
function messageDescription(tool: PlannerGitToolName): string | undefined {
	const properties = gitToolParameters(tool).properties as {
		message?: { description?: string };
	};
	return properties.message?.description;
}

describe("git message tool parameters", () => {
	it("reminds the model to use metadata.commitLanguage on planner_git_commit", () => {
		const description = messageDescription("planner_git_commit");
		expect(description).toContain("commitLanguage");
		expect(description).toContain("planner_status");
	});

	it("reminds the model to use metadata.commitLanguage on merge messages", () => {
		for (const tool of [
			"planner_git_merge_refactor_to_task",
			"planner_git_merge_task_to_plan",
		] as const) {
			expect(messageDescription(tool)).toContain("commitLanguage");
		}
	});
});
