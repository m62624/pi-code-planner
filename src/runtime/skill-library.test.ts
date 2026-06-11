import { describe, expect, it } from "vitest";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	executePlannerSkillTool,
	listActivePlannerSkillPaths,
	validatePlannerSkillMarkdown,
} from "./skill-library";

describe("planner skill library", () => {
	it("creates a validated Pi skill and indexes it", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "skillLanguage": "Russian" } }\n',
		);

		const result = await executePlannerSkillTool({
			fs,
			projectPaths,
			uuid: "12345678-1234-1234-1234-123456789abc",
			now: 1000,
			params: {
				nameHint: "Stale ctx session switch",
				description:
					"ACTIVATE when a Pi extension switches sessions and follow-up messages may use stale ctx.",
				bodyMarkdown: [
					"# Stale Ctx Session Switch",
					"",
					"## Workflow",
					"",
					"- Treat switch handlers as terminal.",
					"- Use replacement context for follow-up messages.",
				].join("\n"),
				tags: ["Pi Extension", "ctx"],
				sourceKind: "debug",
				sourcePlanId: "plan-a",
				sourceTaskId: "task-a",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.details?.item.name).toBe(
			"pi-planner-stale-ctx-session-switch-12345678",
		);
		expect(
			fs.snapshot()[
				"/agent/extensions/pi-code-planner/skills/library/pi-planner-stale-ctx-session-switch-12345678/SKILL.md"
			],
		).toContain("description: >\n  ACTIVATE when a Pi extension switches");
		expect(
			fs.snapshot()["/agent/extensions/pi-code-planner/skills/index.json"],
		).toContain('"language": "Russian"');

		await expect(
			listActivePlannerSkillPaths({ fs, projectPaths }),
		).resolves.toEqual([
			"/agent/extensions/pi-code-planner/skills/library/pi-planner-stale-ctx-session-switch-12345678/SKILL.md",
		]);
	});

	it("rejects skill bodies that include frontmatter", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerSkillTool({
			fs,
			projectPaths,
			params: {
				nameHint: "bad",
				description: "ACTIVATE when testing invalid frontmatter.",
				bodyMarkdown: "---\nname: bad\n---\n# Bad",
				sourceKind: "other",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("must not include YAML frontmatter");
	});

	it("validates Pi-compatible folded and single-line skill frontmatter", () => {
		expect(
			validatePlannerSkillMarkdown(
				[
					"---",
					"name: pi-planner-example-12345678",
					"description: >",
					"  ACTIVATE when a planner task hits a known Pi extension session switch issue.",
					"  Use the fresh replacement ctx for follow-up messages.",
					"---",
					"",
					"# Example",
				].join("\n"),
			),
		).toMatchObject({
			valid: true,
			name: "pi-planner-example-12345678",
		});

		expect(
			validatePlannerSkillMarkdown(
				[
					"---",
					"name: pi-planner-example-12345678",
					"description: Use when a planner task hits a known Pi extension issue.",
					"---",
					"",
					"# Example",
				].join("\n"),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects malformed multiline description indentation", () => {
		const result = validatePlannerSkillMarkdown(
			[
				"---",
				"name: pi-planner-example-12345678",
				"description: >",
				" ACTIVATE when indentation is wrong.",
				"---",
				"",
				"# Example",
			].join("\n"),
		);

		expect(result).toMatchObject({
			valid: false,
			reason: expect.stringContaining("indented with two spaces"),
		});
	});
});
