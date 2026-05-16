import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { createGitCore } from "./core";
import type { GitRunner } from "./runner";

class MockGitRunner implements GitRunner {
	async exec() {
		return { stdout: "", stderr: "" };
	}
}

describe("createGitCore", () => {
	it("initializes settings, state, and reusable git services", () => {
		const fs = new MemoryFs();
		const core = createGitCore({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
			fs,
			runner: new MockGitRunner(),
		});
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});

		expect(fs.exists(paths.globalSettings)).toBe(true);
		expect(fs.exists(paths.projectState)).toBe(true);
		expect(core.settings.settings.git.branchNaming.plan).toBe(
			"planner/{planId}/main",
		);
		expect(core.state.get().mode).toBe("idle");
		expect(core.mutations).toBeDefined();
		expect(core.preflight).toBeDefined();
	});

	it("rejects invalid configured branch naming before exposing mutations", () => {
		const fs = new MemoryFs();
		const paths = createSettingsPaths({
			agentDir: "/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});
		fs.writeFile(
			paths.globalSettings,
			JSON.stringify({
				git: {
					branchNaming: {
						plan: "planner/static",
						child: "planner/{planId}/work/{workItemId}",
						experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
					},
				},
			}),
		);

		expect(() =>
			createGitCore({
				agentDir: "/agent",
				cwd: "/repo",
				extensionName: "pi-planner",
				fs,
				runner: new MockGitRunner(),
			}),
		).toThrow(/missing \{planId\}/);
	});
});
