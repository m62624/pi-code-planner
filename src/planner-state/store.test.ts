import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import {
	initializePlannerRuntimeState,
	loadPlannerRuntimeState,
	parsePlannerRuntimeState,
	savePlannerRuntimeState,
	updatePlannerRuntimeState,
} from "./store";

const paths = createSettingsPaths({
	agentDir: "/home/user/.pi/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

describe("planner runtime state store", () => {
	it("creates default state beside global settings", () => {
		const fs = new MemoryFs();

		const result = initializePlannerRuntimeState(paths, fs);

		expect(result.created).toBe(true);
		expect(result.path).toBe(
			"/home/user/.pi/agent/extensions/pi-planner/state.json",
		);
		expect(result.state).toEqual({
			version: 1,
			mode: "idle",
			activePlanId: null,
			activeWorkItemId: null,
			git: {
				baseBranch: null,
				planBranch: null,
				expectedBranch: null,
				expectedCommit: null,
				lastObservedCommit: null,
			},
			pendingOperation: null,
			pendingCompact: null,
			branches: {
				baseBranch: null,
				planBranch: null,
				items: {},
			},
		});
		expect(fs.exists(paths.globalState)).toBe(true);
	});

	it("does not overwrite existing state", () => {
		const fs = new MemoryFs();
		savePlannerRuntimeState(paths, fs, {
			version: 1,
			mode: "plan_active",
			activePlanId: "plan-1",
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one",
				expectedCommit: "abc123",
				lastObservedCommit: "abc123",
			},
			pendingOperation: null,
			branches: {
				baseBranch: "main",
				planBranch: "plan/one",
				items: {
					main: {
						name: "main",
						kind: "base",
						planId: null,
						workItemId: null,
						createdFromCommit: null,
						lastKnownCommit: "abc123",
						status: "active",
					},
					"plan/one": {
						name: "plan/one",
						kind: "plan",
						planId: "plan-1",
						workItemId: null,
						createdFromCommit: "abc123",
						lastKnownCommit: "abc123",
						status: "active",
					},
				},
			},
		});

		const result = initializePlannerRuntimeState(paths, fs);

		expect(result.created).toBe(false);
		expect(result.state.activePlanId).toBe("plan-1");
		expect(result.state.git.expectedCommit).toBe("abc123");
	});

	it("loads missing state by creating the default file", () => {
		const fs = new MemoryFs();

		const state = loadPlannerRuntimeState(paths, fs);

		expect(state.activePlanId).toBeNull();
		expect(fs.exists(paths.globalState)).toBe(true);
	});

	it("saves state atomically", () => {
		const fs = new MemoryFs();

		savePlannerRuntimeState(paths, fs, {
			version: 1,
			mode: "plan_active",
			activePlanId: "plan-1",
			activeWorkItemId: null,
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one",
				expectedCommit: "def456",
				lastObservedCommit: "def456",
			},
			pendingOperation: null,
			branches: {
				baseBranch: "main",
				planBranch: "plan/one",
				items: {},
			},
		});

		expect(fs.listFiles()).toEqual([paths.globalState]);
		expect(loadPlannerRuntimeState(paths, fs).git.expectedCommit).toBe(
			"def456",
		);
	});

	it("updates state from the persisted value", () => {
		const fs = new MemoryFs();
		initializePlannerRuntimeState(paths, fs);

		const state = updatePlannerRuntimeState(paths, fs, (current) => ({
			...current,
			mode: "plan_active",
			activePlanId: "plan-2",
			git: {
				...current.git,
				baseBranch: "main",
			},
		}));

		expect(state.activePlanId).toBe("plan-2");
		expect(loadPlannerRuntimeState(paths, fs).git.baseBranch).toBe("main");
	});

	it("persists pending operations for crash recovery", () => {
		const fs = new MemoryFs();

		savePlannerRuntimeState(paths, fs, {
			version: 1,
			mode: "operation_in_progress",
			activePlanId: "plan-1",
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one",
				expectedCommit: "abc123",
				lastObservedCommit: "abc123",
			},
			pendingOperation: {
				id: "op-1",
				type: "commit",
				startedAt: "2026-05-14T00:00:00.000Z",
				before: {
					branch: "plan/one",
					commit: "abc123",
				},
				expectedAfter: null,
			},
			branches: {
				baseBranch: "main",
				planBranch: "plan/one",
				items: {},
			},
		});

		const state = loadPlannerRuntimeState(paths, fs);

		expect(state.mode).toBe("operation_in_progress");
		expect(state.pendingOperation).toMatchObject({
			id: "op-1",
			type: "commit",
			before: {
				branch: "plan/one",
				commit: "abc123",
			},
		});
	});

	it("persists branch registry records", () => {
		const fs = new MemoryFs();

		savePlannerRuntimeState(paths, fs, {
			version: 1,
			mode: "plan_active",
			activePlanId: "plan-1",
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one/work/parser",
				expectedCommit: "def456",
				lastObservedCommit: "def456",
			},
			pendingOperation: null,
			branches: {
				baseBranch: "main",
				planBranch: "plan/one",
				items: {
					"plan/one/work/parser": {
						name: "plan/one/work/parser",
						kind: "child",
						planId: "plan-1",
						workItemId: "work-1",
						createdFromCommit: "abc123",
						lastKnownCommit: "def456",
						status: "active",
					},
					"plan/one/work/parser/try-a": {
						name: "plan/one/work/parser/try-a",
						kind: "experiment",
						planId: "plan-1",
						workItemId: "work-1",
						createdFromCommit: "def456",
						lastKnownCommit: "fed987",
						status: "rejected",
					},
				},
			},
		});

		const state = loadPlannerRuntimeState(paths, fs);

		expect(state.branches.items["plan/one/work/parser"]).toMatchObject({
			kind: "child",
			status: "active",
		});
		expect(state.branches.items["plan/one/work/parser/try-a"]).toMatchObject({
			kind: "experiment",
			status: "rejected",
		});
	});

	it("loads old minimal state by filling new persistence fields", () => {
		const fs = new MemoryFs();
		fs.setFile(
			paths.globalState,
			JSON.stringify({
				version: 1,
				activePlanId: "plan-1",
				activeWorkItemId: null,
				git: {
					baseBranch: "main",
					planBranch: "plan/one",
					expectedBranch: "plan/one",
					expectedCommit: "abc123",
					lastObservedCommit: "abc123",
				},
			}),
		);

		const state = loadPlannerRuntimeState(paths, fs);

		expect(state.mode).toBe("plan_active");
		expect(state.pendingOperation).toBeNull();
		expect(state.branches.baseBranch).toBe("main");
		expect(state.branches.items.main).toMatchObject({
			kind: "base",
			status: "active",
		});
	});

	it("rejects malformed state instead of overwriting it", () => {
		const fs = new MemoryFs();
		fs.setFile(paths.globalState, JSON.stringify({ version: 1, git: {} }));

		expect(() => loadPlannerRuntimeState(paths, fs)).toThrow(
			"Invalid planner state field: baseBranch",
		);
	});

	it("rejects unsupported state versions", () => {
		expect(() =>
			parsePlannerRuntimeState({
				version: 2,
				mode: "idle",
				activePlanId: null,
				activeWorkItemId: null,
				git: {},
			}),
		).toThrow("Invalid planner state version");
	});

	it("rejects unknown pending operation types", () => {
		expect(() =>
			parsePlannerRuntimeState({
				version: 1,
				mode: "operation_in_progress",
				activePlanId: "plan-1",
				activeWorkItemId: null,
				git: {
					baseBranch: "main",
					planBranch: "plan/one",
					expectedBranch: "plan/one",
					expectedCommit: "abc123",
					lastObservedCommit: "abc123",
				},
				pendingOperation: {
					id: "op-1",
					type: "unknown",
					startedAt: "2026-05-14T00:00:00.000Z",
					before: {
						branch: "plan/one",
						commit: "abc123",
					},
					expectedAfter: null,
				},
				branches: {
					baseBranch: "main",
					planBranch: "plan/one",
					items: {},
				},
			}),
		).toThrow("Invalid planner state field: type");
	});

	it("rejects branch registry records keyed by the wrong name", () => {
		expect(() =>
			parsePlannerRuntimeState({
				version: 1,
				mode: "plan_active",
				activePlanId: "plan-1",
				activeWorkItemId: null,
				git: {
					baseBranch: "main",
					planBranch: "plan/one",
					expectedBranch: "plan/one",
					expectedCommit: "abc123",
					lastObservedCommit: "abc123",
				},
				pendingOperation: null,
				branches: {
					baseBranch: "main",
					planBranch: "plan/one",
					items: {
						"plan/one/work/parser": {
							name: "different",
							kind: "child",
							planId: "plan-1",
							workItemId: "work-1",
							createdFromCommit: "abc123",
							lastKnownCommit: "abc123",
							status: "active",
						},
					},
				},
			}),
		).toThrow("Invalid planner state branch record name");
	});
});
