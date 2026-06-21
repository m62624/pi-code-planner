import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRunner } from "../git/runner";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { recordPlannerToolEvent } from "./diagnostics";
import { executePlannerRecoveryReportTool } from "./recovery-tools";

// The report tool never touches git; a bare stub is enough.
const noGit = {} as GitRunner;
const thresholds = { blockedTransitions: 4, stuckMs: 25 * 60_000 };

async function setupActivePlan(fs: MockPlannerFs) {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-x");
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({
			planId: "plan-x",
			title: "Secret project plan",
			tasks: [
				{ taskId: "build-secret-thing", title: "Secret", status: "done" },
			],
		}),
	);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-x",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-x",
		}),
		stage: "execution",
		step: "merge_task_to_plan",
		stepStatus: "running",
		activeTaskId: "build-secret-thing",
		currentBranch: "plan/plan-x",
	});
	await setActivePlan(fs, projectPaths, "plan-x");
	return { projectPaths, planPaths };
}

describe("planner_recovery_report tool", () => {
	it("blocks when the planner is not stuck", async () => {
		const fs = new MockPlannerFs();
		const { projectPaths } = await setupActivePlan(fs);

		const result = await executePlannerRecoveryReportTool({
			fs,
			git: noGit,
			projectPaths,
			thresholds,
			modelId: "p/m",
			now: 1_000,
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("unlocks only");
	});

	it("writes a sanitized report once stuck-detection fires", async () => {
		const fs = new MockPlannerFs();
		const { projectPaths, planPaths } = await setupActivePlan(fs);

		// Four blocked transitions in a row trips the threshold.
		for (let i = 0; i < 4; i += 1) {
			await recordPlannerToolEvent(fs, planPaths, {
				ts: i,
				tool: "planner_finish_step",
				status: "blocked",
				stage: "execution",
				step: "merge_task_to_plan",
				task: "build-secret-thing",
			});
		}

		const result = await executePlannerRecoveryReportTool({
			fs,
			git: noGit,
			projectPaths,
			thresholds,
			modelId: "llama-cpp/qwen3.6-35b",
			now: 5,
		});

		expect(result.status).toBe("applied");
		const reportPath = join(planPaths.diagnosticsDir, "report-plan-x.md");
		const legendPath = join(planPaths.diagnosticsDir, "legend-plan-x.md");
		expect(await fs.exists(reportPath)).toBe(true);
		expect(await fs.exists(legendPath)).toBe(true);

		const report = await fs.readText(reportPath);
		expect(report).toContain("llama-cpp/qwen3.6-35b");
		expect(report).toContain(
			"https://github.com/m62624/pi-code-planner/issues",
		);
		expect(report).toContain("T1");
		// No raw task id, plan title, or path leaks into the attachable report.
		expect(report).not.toContain("build-secret-thing");
		expect(report).not.toContain("Secret project plan");
		expect(report).not.toContain("/repo/app");

		// The real id survives only in the local legend.
		const legend = await fs.readText(legendPath);
		expect(legend).toContain("build-secret-thing");

		// The tool tells the model to ask the user to verify and file an issue.
		expect(result.text).toContain("review");
		expect(result.text).toContain("issue");
	});
});
