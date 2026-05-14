import { describe, expect, it } from "vitest";
import { ensurePlannerFiles } from "../settings/initializer";
import { loadPlannerSettings } from "../settings/loader";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { getInstructionSectionContent } from "./manager";

function setup() {
	const fs = new MemoryFs();
	const paths = createSettingsPaths({
		agentDir: "/agent",
		cwd: "/repo",
		extensionName: "pi-planner",
	});
	ensurePlannerFiles(paths, fs);
	return { fs, paths };
}

describe("getInstructionSectionContent", () => {
	it("loads a named section from the effective instruction file", () => {
		const { fs, paths } = setup();
		fs.setFile(
			`${paths.globalInstructionsDir}/commit_style.md`,
			"## commit.work_item\n\nUse concise commits.",
		);
		const loaded = loadPlannerSettings(paths, fs);

		const content = getInstructionSectionContent(loaded, fs, {
			instructionName: "commit_style",
			sectionName: "commit.work_item",
		});

		expect(content).toBe("Use concise commits.");
	});

	it("uses project-overridden instruction files", () => {
		const { fs, paths } = setup();
		fs.setFile(
			`${paths.globalInstructionsDir}/commit_style.md`,
			"## commit.work_item\n\nglobal",
		);
		fs.setFile(
			`${paths.projectInstructionsDir}/commit_style.md`,
			"## commit.work_item\n\nproject",
		);
		const loaded = loadPlannerSettings(paths, fs);

		const content = getInstructionSectionContent(loaded, fs, {
			instructionName: "commit_style",
			sectionName: "commit.work_item",
		});

		expect(content).toBe("project");
	});

	it("can append a details section", () => {
		const { fs, paths } = setup();
		fs.setFile(
			`${paths.globalInstructionsDir}/work_item.md`,
			[
				"## tdd.red",
				"",
				"write failing tests",
				"",
				"## details",
				"",
				"be strict",
			].join("\n"),
		);
		const loaded = loadPlannerSettings(paths, fs);

		const content = getInstructionSectionContent(loaded, fs, {
			instructionName: "work_item",
			sectionName: "tdd.red",
			includeDetails: true,
		});

		expect(content).toBe("write failing tests\n\nbe strict");
	});

	it("throws for required missing sections", () => {
		const { fs, paths } = setup();
		fs.setFile(`${paths.globalInstructionsDir}/plan.md`, "## details\n\ntext");
		const loaded = loadPlannerSettings(paths, fs);

		expect(() =>
			getInstructionSectionContent(loaded, fs, {
				instructionName: "plan",
				sectionName: "plan.create",
			}),
		).toThrow("Instruction section not found: plan:plan.create");
	});

	it("returns null for optional missing sections", () => {
		const { fs, paths } = setup();
		fs.setFile(`${paths.globalInstructionsDir}/plan.md`, "## details\n\ntext");
		const loaded = loadPlannerSettings(paths, fs);

		const content = getInstructionSectionContent(loaded, fs, {
			instructionName: "plan",
			sectionName: "plan.create",
			required: false,
		});

		expect(content).toBeNull();
	});
});
