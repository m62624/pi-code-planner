import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import {
	getAttemptStoragePaths,
	getPlanStoragePaths,
	getProjectStoragePaths,
	getWorkItemStoragePaths,
} from "./paths";
import { PlanStore } from "./store";

const settingsPaths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createStore() {
	const fs = new MemoryFs();
	const store = new PlanStore({
		paths: settingsPaths,
		fs,
		now: () => "2026-05-15T00:00:00.000Z",
	});
	return { fs, store };
}

describe("PlanStore", () => {
	it("creates and reads a project record", () => {
		const { fs, store } = createStore();

		const project = store.ensureProject("/home/user/projects/app");
		const paths = getProjectStoragePaths({
			paths: settingsPaths,
			projectPath: "/home/user/projects/app",
		});

		expect(project).toMatchObject({
			version: 1,
			projectKey: paths.projectKey,
			name: "app",
			rootPath: "/home/user/projects/app",
		});
		expect(fs.exists(paths.projectRecord)).toBe(true);
		expect(fs.exists(paths.projectMemoryDir)).toBe(true);
		expect(fs.exists(paths.plansDir)).toBe(true);
		expect(store.readProject("/home/user/projects/app")).toEqual(project);
	});

	it("does not overwrite an existing project record", () => {
		const { store } = createStore();
		const first = store.ensureProject("/repo");
		const second = store.ensureProject("/repo");

		expect(second).toEqual(first);
	});

	it("creates a plan record and markdown placeholders", () => {
		const { fs, store } = createStore();

		const plan = store.createPlan("/repo", {
			title: "Auth Refactor",
			planId: "auth-refactor",
		});
		const paths = getPlanStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "auth-refactor",
		});

		expect(plan).toMatchObject({
			version: 1,
			planId: "auth-refactor",
			title: "Auth Refactor",
			stage: "plan_draft",
			status: "draft",
		});
		expect(fs.exists(paths.planRecord)).toBe(true);
		expect(fs.exists(paths.planMarkdown)).toBe(true);
		expect(fs.exists(paths.planDiscovery)).toBe(true);
		expect(fs.exists(paths.planQuestions)).toBe(true);
		expect(fs.exists(paths.planDecisions)).toBe(true);
		expect(fs.exists(paths.workItemsDir)).toBe(true);
		expect(store.readPlan("/repo", "auth-refactor")).toEqual(plan);
	});

	it("creates a dated plan id when none is provided", () => {
		const { store } = createStore();

		const plan = store.createPlan("/repo", { title: "Parser API" });

		expect(plan.planId).toBe("parser-api-20260515");
	});

	it("rejects duplicate plan records", () => {
		const { store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });

		expect(() =>
			store.createPlan("/repo", { title: "Plan", planId: "plan-1" }),
		).toThrow(/already exists/);
	});

	it("updates a plan record", () => {
		const { store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });

		const updated = store.updatePlan("/repo", "plan-1", {
			stage: "discovery_full",
			status: "draft",
		});

		expect(updated).toMatchObject({
			planId: "plan-1",
			stage: "discovery_full",
			status: "draft",
			updatedAt: "2026-05-15T00:00:00.000Z",
		});
		expect(store.readPlan("/repo", "plan-1")).toEqual(updated);
	});

	it("creates a work item record and placeholders", () => {
		const { fs, store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });

		const workItem = store.createWorkItem("/repo", "plan-1", {
			title: "Parser API",
		});
		const paths = getWorkItemStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "plan-1",
			workItemId: "parser-api",
		});

		expect(workItem).toMatchObject({
			version: 1,
			planId: "plan-1",
			workItemId: "parser-api",
			stage: "pending",
			status: "pending",
		});
		expect(fs.exists(paths.workItemRecord)).toBe(true);
		expect(fs.exists(paths.workItemTddPlan)).toBe(true);
		expect(fs.exists(paths.workItemTestsSummary)).toBe(true);
		expect(fs.exists(paths.workItemRefactorNotes)).toBe(true);
		expect(fs.exists(paths.experimentsDir)).toBe(true);
		expect(store.readWorkItem("/repo", "plan-1", "parser-api")).toEqual(
			workItem,
		);
	});

	it("requires a plan before creating a work item", () => {
		const { store } = createStore();

		expect(() =>
			store.createWorkItem("/repo", "missing", { title: "Parser API" }),
		).toThrow(/File not found/);
	});

	it("updates a work item record", () => {
		const { store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
		store.createWorkItem("/repo", "plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});

		const updated = store.updateWorkItem("/repo", "plan-1", "parser-api", {
			stage: "ready",
			status: "ready",
		});

		expect(updated).toMatchObject({
			workItemId: "parser-api",
			stage: "ready",
			status: "ready",
		});
		expect(store.readWorkItem("/repo", "plan-1", "parser-api")).toEqual(
			updated,
		);
	});

	it("creates an experiment attempt record and artifacts", () => {
		const { fs, store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
		store.createWorkItem("/repo", "plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});

		const attempt = store.createAttempt("/repo", "plan-1", "parser-api", {
			attemptIndex: 2,
		});
		const paths = getAttemptStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "plan-1",
			workItemId: "parser-api",
			attemptId: "attempt-2",
		});

		expect(attempt).toMatchObject({
			version: 1,
			planId: "plan-1",
			workItemId: "parser-api",
			attemptId: "attempt-2",
			stage: "created",
			status: "created",
		});
		expect(fs.exists(paths.attemptRecord)).toBe(true);
		expect(fs.exists(paths.attemptPlan)).toBe(true);
		expect(fs.exists(paths.attemptPrompt)).toBe(true);
		expect(fs.exists(paths.attemptSummary)).toBe(true);
		expect(fs.readFile(paths.attemptScore)).toBe("{}\n");
		expect(fs.readFile(paths.attemptVerification)).toBe("{}\n");
		expect(fs.readFile(paths.attemptChangedFiles)).toBe("[]\n");
		expect(
			store.readAttempt("/repo", "plan-1", "parser-api", "attempt-2"),
		).toEqual(attempt);
	});

	it("validates records while reading", () => {
		const { fs, store } = createStore();
		const paths = getPlanStoragePaths({
			paths: settingsPaths,
			projectPath: "/repo",
			planId: "bad",
		});
		fs.writeFile(paths.planRecord, JSON.stringify({ version: 2 }));

		expect(() => store.readPlan("/repo", "bad")).toThrow(/version/);
	});

	it("updates an experiment attempt record", () => {
		const { store } = createStore();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
		store.createWorkItem("/repo", "plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});
		store.createAttempt("/repo", "plan-1", "parser-api", {
			attemptId: "attempt-1",
		});

		const updated = store.updateAttempt(
			"/repo",
			"plan-1",
			"parser-api",
			"attempt-1",
			{
				stage: "active",
				status: "active",
			},
		);

		expect(updated).toMatchObject({
			attemptId: "attempt-1",
			stage: "active",
			status: "active",
		});
		expect(
			store.readAttempt("/repo", "plan-1", "parser-api", "attempt-1"),
		).toEqual(updated);
	});
});
