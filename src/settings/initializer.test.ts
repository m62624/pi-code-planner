import { describe, expect, it } from "vitest";
import { MemoryFs } from "../test/memory-fs";
import { ensurePlannerFiles } from "./initializer";
import { createSettingsPaths } from "./paths";

describe("ensurePlannerFiles", () => {
	it("creates global settings and empty instruction files", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/home/user/.pi/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});

		const result = ensurePlannerFiles(paths, fs);

		expect(result.created).toContain(
			"/home/user/.pi/agent/extensions/pi-planner/settings.json",
		);
		expect(fs.exists(`${paths.globalInstructionsDir}/discovery.md`)).toBe(true);
		expect(fs.readFile(`${paths.globalInstructionsDir}/discovery.md`)).toBe("");
		expect(fs.exists(`${paths.globalInstructionsDir}/commit_style.md`)).toBe(
			true,
		);
	});

	it("does not overwrite existing files", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/home/user/.pi/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		fs.setFile(`${paths.globalInstructionsDir}/discovery.md`, "custom");

		ensurePlannerFiles(paths, fs);

		expect(fs.readFile(`${paths.globalInstructionsDir}/discovery.md`)).toBe(
			"custom",
		);
	});
});
