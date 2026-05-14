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
			activePlanId: null,
			activeWorkItemId: null,
			git: {
				baseBranch: null,
				planBranch: null,
				expectedBranch: null,
				expectedCommit: null,
				lastObservedCommit: null,
			},
		});
		expect(fs.exists(paths.globalState)).toBe(true);
	});

	it("does not overwrite existing state", () => {
		const fs = new MemoryFs();
		savePlannerRuntimeState(paths, fs, {
			version: 1,
			activePlanId: "plan-1",
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one",
				expectedCommit: "abc123",
				lastObservedCommit: "abc123",
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
			activePlanId: "plan-1",
			activeWorkItemId: null,
			git: {
				baseBranch: "main",
				planBranch: "plan/one",
				expectedBranch: "plan/one",
				expectedCommit: "def456",
				lastObservedCommit: "def456",
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
			activePlanId: "plan-2",
			git: {
				...current.git,
				baseBranch: "main",
			},
		}));

		expect(state.activePlanId).toBe("plan-2");
		expect(loadPlannerRuntimeState(paths, fs).git.baseBranch).toBe("main");
	});

	it("rejects malformed state instead of overwriting it", () => {
		const fs = new MemoryFs();
		fs.setFile(paths.globalState, JSON.stringify({ version: 1, git: {} }));

		expect(() => loadPlannerRuntimeState(paths, fs)).toThrow(
			"Invalid planner state field: activePlanId",
		);
	});

	it("rejects unsupported state versions", () => {
		expect(() =>
			parsePlannerRuntimeState({
				version: 2,
				activePlanId: null,
				activeWorkItemId: null,
				git: {},
			}),
		).toThrow("Invalid planner state version");
	});
});
