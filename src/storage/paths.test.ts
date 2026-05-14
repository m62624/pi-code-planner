import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import {
	getAttemptStoragePaths,
	getPlanStoragePaths,
	getProjectStoragePaths,
	getProjectsRoot,
	getWorkItemStoragePaths,
} from "./paths";

const settingsPaths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

describe("storage paths", () => {
	it("builds the projects root under the global extension directory", () => {
		expect(getProjectsRoot(settingsPaths)).toBe(
			"/agent/extensions/pi-planner/projects",
		);
	});

	it("builds project storage paths under a deterministic project key", () => {
		const paths = getProjectStoragePaths({
			paths: settingsPaths,
			projectPath: "/home/user/projects/app",
		});

		expect(paths.projectKey).toMatch(/^app-[a-f0-9]{8}$/);
		expect(paths.projectDir).toBe(
			`/agent/extensions/pi-planner/projects/${paths.projectKey}`,
		);
		expect(paths.projectRecord).toBe(`${paths.projectDir}/project.json`);
		expect(paths.projectMemoryDir).toBe(`${paths.projectDir}/memory`);
		expect(paths.plansDir).toBe(`${paths.projectDir}/plans`);
	});

	it("builds plan storage paths", () => {
		const paths = getPlanStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "auth-refactor-20260515",
		});

		expect(paths.planDir).toBe(`${paths.plansDir}/auth-refactor-20260515`);
		expect(paths.planRecord).toBe(`${paths.planDir}/plan.json`);
		expect(paths.planMarkdown).toBe(`${paths.planDir}/plan.md`);
		expect(paths.workItemsDir).toBe(`${paths.planDir}/work_items`);
	});

	it("builds work item storage paths", () => {
		const paths = getWorkItemStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "plan-1",
			workItemId: "parser-api",
		});

		expect(paths.workItemDir).toBe(`${paths.workItemsDir}/parser-api`);
		expect(paths.workItemRecord).toBe(`${paths.workItemDir}/work_item.json`);
		expect(paths.experimentsDir).toBe(`${paths.workItemDir}/experiments`);
	});

	it("builds attempt storage paths", () => {
		const paths = getAttemptStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "plan-1",
			workItemId: "parser-api",
			attemptId: "attempt-2",
		});

		expect(paths.attemptDir).toBe(`${paths.experimentsDir}/attempt-2`);
		expect(paths.attemptPlan).toBe(`${paths.attemptDir}/plan.md`);
		expect(paths.attemptSummary).toBe(`${paths.attemptDir}/summary.md`);
		expect(paths.attemptScore).toBe(`${paths.attemptDir}/score.json`);
	});
});
