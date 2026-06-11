import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	validatePostImplementationCounterexampleReview,
	validatePreImplementationProofContract,
	validateTaskMergeScopeAudit,
} from "./tdd-evidence";

describe("TDD evidence gates", () => {
	it("requires the pre-implementation proof contract", async () => {
		const fs = new MockPlannerFs();
		const path = "/plan/tasks/task-1/tdd.md";
		await fs.writeTextAtomic(
			path,
			"# TDD\n\n## Pre-Implementation Proof Contract\n- note: incomplete\n",
		);

		await expect(
			validatePreImplementationProofContract(fs, path),
		).resolves.toContain("failingSignal");

		await fs.writeTextAtomic(
			path,
			[
				"# TDD",
				"",
				"## Pre-Implementation Proof Contract",
				"- failingSignal: npm test fails on missing parser branch",
				"- productionPath: src/parser.ts parseValue",
				"- successSignal: npm test parser.invalid passes",
				"- outOfScopeFiles: src/runtime/**",
				"",
			].join("\n"),
		);

		await expect(
			validatePreImplementationProofContract(fs, path),
		).resolves.toBeNull();
	});

	it("requires post-implementation counterexample review", async () => {
		const fs = new MockPlannerFs();
		const path = "/plan/tasks/task-1/tdd.md";
		await fs.writeTextAtomic(
			path,
			[
				"# TDD",
				"",
				"## Post-Implementation Counterexample Review",
				"- counterexample: empty input still fails",
				"- boundaryValue: minimum length checked",
				"- oppositeCase: valid input still passes",
				"- regressionRisk: old invalid message path",
				"- scopeCheck: only parser file changed",
				"- action: added empty input assertion",
				"",
			].join("\n"),
		);

		await expect(
			validatePostImplementationCounterexampleReview(fs, path),
		).resolves.toBeNull();
	});

	it("requires task merge scope audit", async () => {
		const fs = new MockPlannerFs();
		const path = "/plan/tasks/task-1/tdd.md";
		await fs.writeTextAtomic(
			path,
			[
				"# TDD",
				"",
				"## Task Merge Scope Audit",
				"- acceptanceCriteriaCovered: all task criteria mapped to tests",
				"- changedFilesMatchScope: src/parser.ts and parser tests only",
				"- testsRun: npm test parser.invalid",
				"- debugRemoved: no temporary logs in diff",
				"- commitMessageMatchesBehavior: commit subject names parser fix",
				"- branchDriftCheck: planner_status reported expected task branch",
				"",
			].join("\n"),
		);

		await expect(validateTaskMergeScopeAudit(fs, path)).resolves.toBeNull();
	});
});
