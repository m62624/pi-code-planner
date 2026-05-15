import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { createMemoryCore } from "./core";
import { getProjectMemoryPaths } from "./paths";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

describe("createMemoryCore", () => {
	it("initializes and exposes the project memory store", () => {
		const fs = new MemoryFs();
		const core = createMemoryCore({
			paths,
			fs,
			projectPath: "/repo",
		});
		const memoryPaths = getProjectMemoryPaths({ paths, projectPath: "/repo" });

		expect(core.store.loadManifest()).toMatchObject({
			projectPath: "/repo",
		});
		expect(fs.exists(memoryPaths.manifest)).toBe(true);
	});
});
