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
		for (const artifact of ["tdd.md", "refactor.md"]) {
			expect(await fs.readText(join(result.paths.taskDir, artifact))).toBe("");
		}
		for (const artifact of ["tests.md", "implementation.md", "verify.md"]) {
			expect(await fs.exists(join(result.paths.taskDir, artifact))).toBe(false);
		}
	});

	it("defaults requirements to [] when reading a legacy task.json", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
			"plan-a",
		);
		const result = await upsertTaskArtifacts(fs, planPaths, {
			taskId: "legacy-task",
			title: "Legacy",
			objective: "Predates spec traceability.",
			scope: [],
			acceptanceCriteria: ["Parses unchanged."],
		});
		// Simulate a legacy record written before the requirements field existed.
		const raw = JSON.parse(await fs.readText(result.paths.taskJson));
		delete raw.requirements;
		await fs.writeTextAtomic(result.paths.taskJson, JSON.stringify(raw));

		expect((await readTaskRecord(fs, result.paths)).requirements).toEqual([]);
	});

	it("persists requirements and renders them into task.md", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
			"plan-a",
		);
		const result = await upsertTaskArtifacts(fs, planPaths, {
			taskId: "traced-task",
			title: "Traced",
			objective: "Discharges spec requirements.",
			scope: [],
			acceptanceCriteria: ["Covered."],
			requirements: ["REQ-1", "REQ-3"],
		});
		expect((await readTaskRecord(fs, result.paths)).requirements).toEqual([
			"REQ-1",
			"REQ-3",
		]);
		const md = await fs.readText(result.paths.taskMd);
		expect(md).toContain("## Spec Requirements");
		expect(md).toContain("- REQ-1");
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
			}),
		).rejects.toThrow("taskId");
		await expect(
			upsertTaskArtifacts(fs, planPaths, {
				taskId: "..",
				title: "Unsafe",
				objective: "Unsafe.",
				scope: [],
				acceptanceCriteria: ["Never written."],
			}),
		).rejects.toThrow("taskId");
	});
});
