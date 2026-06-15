import { describe, expect, it } from "vitest";
import {
	ARTIFACT_CANONICAL_SCHEMA,
	formatArtifactEcho,
	formatCanonicalSchemaHint,
} from "./artifact-echo";

// Every strict-structure planner tool that writes markdown must have a canonical
// schema to echo back, so the "expected vs received" feedback is uniform.
const STRICT_TOOLS = [
	"planner_goal_submit",
	"planner_questions_submit",
	"planner_plan_submit",
	"planner_discovery_submit",
	"planner_tdd_submit",
	"planner_summary_submit",
	"planner_task_upsert",
	"planner_refactor_review",
	"planner_doubt_review",
	"planner_contract_upsert",
	"planner_skill_create",
	"planner_skill_update",
];

describe("artifact echo", () => {
	it("has a canonical schema for every strict tool", () => {
		for (const tool of STRICT_TOOLS) {
			expect(ARTIFACT_CANONICAL_SCHEMA[tool]?.trim().length).toBeGreaterThan(0);
		}
	});

	it("echoes both expected shape and what was written", () => {
		const text = formatArtifactEcho({
			canonicalSchema: "# Example\n## Section",
			writtenMarkdown: "# Real\n## Done\n",
		});
		expect(text).toContain("Expected shape");
		expect(text).toContain("## Section");
		expect(text).toContain("What you submitted");
		expect(text).toContain("# Real");
	});

	it("schema-only hint shows the expected shape without a written block", () => {
		const text = formatCanonicalSchemaHint("# Example\n## Section");
		expect(text).toContain("Expected shape");
		expect(text).not.toContain("What you submitted");
	});
});
