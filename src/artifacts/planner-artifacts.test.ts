import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { PlanStore } from "../storage/store";
import { MemoryFs } from "../test/memory-fs";
import { PlannerArtifacts } from "./planner-artifacts";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createHarness() {
	const fs = new MemoryFs();
	const store = new PlanStore({ paths, fs });
	store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
	store.createWorkItem("/repo", "plan-1", {
		title: "Parser API",
		workItemId: "parser-api",
	});
	store.createAttempt("/repo", "plan-1", "parser-api", {
		attemptId: "attempt-1",
	});
	return {
		artifacts: new PlannerArtifacts({ paths, fs }),
		fs,
	};
}

describe("PlannerArtifacts", () => {
	it("reads and writes plan artifacts", () => {
		const { artifacts } = createHarness();

		const written = artifacts.writePlanArtifact(
			"/repo",
			"plan-1",
			"discovery",
			"Discovery notes",
		);
		const read = artifacts.readPlanArtifact("/repo", "plan-1", "discovery");

		expect(written.exists).toBe(true);
		expect(read).toMatchObject({
			name: "discovery",
			content: "Discovery notes",
			exists: true,
		});
		expect(read.path).toContain("/plans/plan-1/discovery.md");
	});

	it("appends plan artifacts with a newline separator", () => {
		const { artifacts } = createHarness();

		artifacts.writePlanArtifact("/repo", "plan-1", "questions", "Q1");
		const read = artifacts.appendPlanArtifact(
			"/repo",
			"plan-1",
			"questions",
			"Q2",
		);

		expect(read.content).toBe("Q1\nQ2");
	});

	it("reads and writes work item artifacts", () => {
		const { artifacts } = createHarness();

		artifacts.writeWorkItemArtifact(
			"/repo",
			"plan-1",
			"parser-api",
			"tdd_plan",
			"Test first",
		);

		expect(
			artifacts.readWorkItemArtifact(
				"/repo",
				"plan-1",
				"parser-api",
				"tdd_plan",
			),
		).toMatchObject({
			content: "Test first",
			exists: true,
		});
	});

	it("reads and writes attempt artifacts", () => {
		const { artifacts } = createHarness();

		artifacts.writeAttemptArtifact(
			"/repo",
			"plan-1",
			"parser-api",
			"attempt-1",
			"summary",
			"Attempt summary",
		);

		expect(
			artifacts.readAttemptArtifact(
				"/repo",
				"plan-1",
				"parser-api",
				"attempt-1",
				"summary",
			),
		).toMatchObject({
			content: "Attempt summary",
			exists: true,
		});
	});

	it("returns an empty missing artifact result", () => {
		const fs = new MemoryFs();
		const artifacts = new PlannerArtifacts({ paths, fs });

		const result = artifacts.readPlanArtifact("/repo", "plan-1", "plan");

		expect(result).toMatchObject({
			name: "plan",
			content: "",
			exists: false,
		});
	});
});
