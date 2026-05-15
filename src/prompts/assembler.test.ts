import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { SettingsLoadResult } from "../settings/schema";
import { MemoryFs } from "../test/memory-fs";
import { artifactReference, assemblePlannerPrompt } from "./assembler";

function loadResult(path: string): SettingsLoadResult {
	return {
		settings: DEFAULT_SETTINGS,
		sources: {
			defaults: "built-in",
			instructions: {
				discovery: path,
			},
		},
	};
}

describe("assemblePlannerPrompt", () => {
	it("assembles a full instruction with state and artifact paths", () => {
		const fs = new MemoryFs();
		fs.setFile("/instructions/discovery.md", "Read the project.");

		const result = assemblePlannerPrompt(
			loadResult("/instructions/discovery.md"),
			fs,
			{
				instructionName: "discovery",
				state: [
					{ name: "planId", value: "plan-1" },
					{ name: "stage", value: "discovery_full" },
				],
				artifacts: [
					{
						name: "plan",
						path: "/plans/plan-1/plan.md",
					},
				],
			},
		);

		expect(result.prompt).toContain("## Planner Instruction");
		expect(result.prompt).toContain("Read the project.");
		expect(result.prompt).toContain("- planId: plan-1");
		expect(result.prompt).toContain("- plan: /plans/plan-1/plan.md");
		expect(result.artifactPaths).toEqual(["/plans/plan-1/plan.md"]);
	});

	it("uses a named instruction section with optional details", () => {
		const fs = new MemoryFs();
		fs.setFile(
			"/instructions/discovery.md",
			[
				"# Discovery",
				"Study architecture.",
				"",
				"# Details",
				"Do not implement yet.",
			].join("\n"),
		);

		const result = assemblePlannerPrompt(
			loadResult("/instructions/discovery.md"),
			fs,
			{
				instructionName: "discovery",
				sectionName: "discovery",
				includeDetails: true,
			},
		);

		expect(result.instruction).toBe(
			"Study architecture.\n\nDo not implement yet.",
		);
	});

	it("throws when a required section is missing", () => {
		const fs = new MemoryFs();
		fs.setFile("/instructions/discovery.md", "# Other\nNope");

		expect(() =>
			assemblePlannerPrompt(loadResult("/instructions/discovery.md"), fs, {
				instructionName: "discovery",
				sectionName: "discovery",
			}),
		).toThrow("Instruction section not found: discovery:discovery");
	});

	it("can embed artifact content", () => {
		const fs = new MemoryFs();
		fs.setFile("/instructions/discovery.md", "Read artifact.");

		const result = assemblePlannerPrompt(
			loadResult("/instructions/discovery.md"),
			fs,
			{
				instructionName: "discovery",
				artifacts: [
					artifactReference(
						{
							name: "discovery",
							path: "/plans/plan-1/discovery.md",
							content: "Existing notes",
							exists: true,
						},
						{ includeContent: true },
					),
				],
				extraInstructions: ["Ask questions if unclear."],
			},
		);

		expect(result.prompt).toContain("### discovery");
		expect(result.prompt).toContain("Existing notes");
		expect(result.prompt).toContain("Ask questions if unclear.");
	});
});
