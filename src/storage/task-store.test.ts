import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import { readTaskRecord, upsertTaskArtifacts } from "./task-store";

describe("planner task store", () => {
	it("creates task json and empty lifecycle artifacts from semantic fields", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
			"plan-a",
		);

		const result = await upsertTaskArtifacts(fs, planPaths, {
			taskId: "parse-config",
			title: "Parse configuration",
			objective: "Parse config files with explicit validation.",
			scope: ["src/config.ts"],
			acceptanceCriteria: ["Invalid input returns a typed error."],
			memoryHints: ["parseConfig", "ConfigError"],
		});

		expect(await readTaskRecord(fs, result.paths)).toMatchObject({
			taskId: "parse-config",
			status: "pending",
			scope: ["src/config.ts"],
		});
		expect(await fs.readText(result.paths.taskMd)).toContain(
			"# Parse configuration",
		);
		expect(await fs.readText(result.paths.taskMd)).toContain(
			"Invalid input returns a typed error.",
		);
		for (const artifact of [
			"tdd.md",
			"tests.md",
			"implementation.md",
			"refactor.md",
			"verify.md",
		]) {
			expect(await fs.readText(join(result.paths.taskDir, artifact))).toBe("");
		}
	});

	it("rejects unsafe task ids", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
			"plan-a",
		);

		await expect(
			upsertTaskArtifacts(fs, planPaths, {
				taskId: "../outside",
				title: "Unsafe",
				objective: "Unsafe.",
				scope: [],
				acceptanceCriteria: ["Never written."],
				memoryHints: [],
			}),
		).rejects.toThrow("taskId");
		await expect(
			upsertTaskArtifacts(fs, planPaths, {
				taskId: "..",
				title: "Unsafe",
				objective: "Unsafe.",
				scope: [],
				acceptanceCriteria: ["Never written."],
				memoryHints: [],
			}),
		).rejects.toThrow("taskId");
	});
});
