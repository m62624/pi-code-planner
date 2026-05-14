import { describe, expect, it } from "vitest";
import { MemoryFs } from "../test/memory-fs";
import { ensurePlannerFiles } from "./initializer";
import { getInstructionContent, loadPlannerSettings } from "./loader";
import { createSettingsPaths } from "./paths";

describe("loadPlannerSettings", () => {
	it("loads defaults from generated global files", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.settings.refactor.maxIterations).toBe(3);
		expect(loaded.sources.globalSettings).toBe(paths.globalSettings);
		expect(loaded.sources.instructions.discovery).toBe(
			"/agent/extensions/pi-planner/instructions/discovery.md",
		);
	});

	it("project settings override global settings", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);
		fs.setFile(
			paths.globalSettings,
			JSON.stringify({ refactor: { maxIterations: 5 } }),
		);
		fs.setFile(
			paths.projectSettings,
			JSON.stringify({ refactor: { maxIterations: 1 } }),
		);

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.settings.refactor.maxIterations).toBe(1);
		expect(loaded.sources.projectSettings).toBe(paths.projectSettings);
	});

	it("loads default git guardrail settings", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.settings.git.shellToolNames).toEqual(["bash"]);
		expect(loaded.settings.git.blockedCommitPatterns).toContain(
			"\\bgit\\s+commit\\b",
		);
		expect(loaded.settings.git.blockedDangerousPatterns).toContain(
			"\\bgit\\s+reset\\b",
		);
		expect(loaded.settings.git.branchNaming).toEqual({
			plan: "planner/{planId}/main",
			child: "planner/{planId}/work/{workItemId}",
			experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
		});
		expect(loaded.settings.git.deleteChildBranch).toBe(true);
	});

	it("project settings override git guardrail arrays and flags", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);
		fs.setFile(
			paths.projectSettings,
			JSON.stringify({
				git: {
					shellToolNames: ["bash", "shell"],
					blockedCommitPatterns: ["\\bgit\\s+commit\\b", "\\bgcam\\b"],
					branchNaming: {
						child: "pi/{planId}/child/{workItemId}",
					},
					archiveChildPlans: true,
				},
			}),
		);

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.settings.git.shellToolNames).toEqual(["bash", "shell"]);
		expect(loaded.settings.git.blockedCommitPatterns).toEqual([
			"\\bgit\\s+commit\\b",
			"\\bgcam\\b",
		]);
		expect(loaded.settings.git.blockedDangerousPatterns).toContain(
			"\\bgit\\s+merge\\b",
		);
		expect(loaded.settings.git.branchNaming).toEqual({
			plan: "planner/{planId}/main",
			child: "pi/{planId}/child/{workItemId}",
			experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
		});
		expect(loaded.settings.git.archiveChildPlans).toBe(true);
	});

	it("project markdown file wins over global markdown file", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);
		fs.setFile(`${paths.projectInstructionsDir}/work_item.md`, "project");

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.sources.instructions.work_item).toBe(
			"/repo/.pi/extensions/pi-planner/instructions/work_item.md",
		);
	});

	it("custom instruction paths are resolved relative to owning config dirs", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);
		fs.setFile(
			paths.projectSettings,
			JSON.stringify({ instructions: { compact: "custom/compact.md" } }),
		);
		fs.setFile(`${paths.projectDir}/custom/compact.md`, "project compact");

		const loaded = loadPlannerSettings(paths, fs);

		expect(loaded.sources.instructions.compact).toBe(
			"/repo/.pi/extensions/pi-planner/custom/compact.md",
		);
	});

	it("reads effective instruction content by instruction name", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		ensurePlannerFiles(paths, fs);
		fs.setFile(`${paths.projectInstructionsDir}/discovery.md`, "project rules");
		const loaded = loadPlannerSettings(paths, fs);

		const content = getInstructionContent(loaded, fs, "discovery");

		expect(content).toBe("project rules");
	});
});
