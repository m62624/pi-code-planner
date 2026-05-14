import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { RuntimeStateManager } from "./runtime";
import type { PlannerRuntimeState } from "./schema";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function activeState(): PlannerRuntimeState {
	return {
		version: 1,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: "work-1",
		git: {
			baseBranch: "main",
			planBranch: "planner/plan",
			expectedBranch: "planner/plan",
			expectedCommit: "abc123",
			lastObservedCommit: "abc123",
		},
		pendingOperation: null,
		branches: {
			baseBranch: "main",
			planBranch: "planner/plan",
			items: {},
		},
	};
}

describe("RuntimeStateManager", () => {
	it("initializes state and caches it", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });

		const result = manager.initialize();

		expect(result.created).toBe(true);
		expect(manager.get()).toBe(result.state);
		expect(fs.exists(paths.globalState)).toBe(true);
	});

	it("loads state lazily when get is called without initialize", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });

		const state = manager.get();

		expect(state.mode).toBe("idle");
		expect(fs.exists(paths.globalState)).toBe(true);
	});

	it("updates disk first and then the RAM cache", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		manager.initialize();

		const state = manager.update((current) => ({
			...current,
			mode: "plan_active",
			activePlanId: "plan-1",
		}));

		expect(manager.get()).toBe(state);
		expect(JSON.parse(fs.readFile(paths.globalState)).activePlanId).toBe(
			"plan-1",
		);
	});

	it("does not update RAM cache when disk write fails", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		const initial = manager.initialize().state;
		fs.rename = () => {
			throw new Error("disk failed");
		};

		expect(() =>
			manager.update((current) => ({
				...current,
				activePlanId: "plan-1",
			})),
		).toThrow("disk failed");
		expect(manager.get()).toBe(initial);
	});

	it("refreshes RAM cache from disk", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		manager.initialize();
		const external = activeState();
		fs.setFile(paths.globalState, JSON.stringify(external));

		const refreshed = manager.refresh();

		expect(refreshed.activePlanId).toBe("plan-1");
		expect(manager.get()).toBe(refreshed);
	});

	it("reports active when plan is active", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		manager.replace(activeState());

		expect(manager.isActive()).toBe(true);
	});

	it("reports active during pending operation even without active plan id", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		manager.replace({
			...activeState(),
			mode: "operation_in_progress",
			activePlanId: null,
			pendingOperation: {
				id: "op-1",
				type: "commit",
				startedAt: "2026-05-14T00:00:00.000Z",
				before: {
					branch: "planner/plan",
					commit: "abc123",
				},
				expectedAfter: null,
			},
		});

		expect(manager.isActive()).toBe(true);
	});

	it("can put the runtime back to sleep", () => {
		const fs = new MemoryFs();
		const manager = new RuntimeStateManager({ paths, fs });
		manager.replace(activeState());

		const state = manager.sleep();

		expect(state).toMatchObject({
			mode: "idle",
			activePlanId: null,
			activeWorkItemId: null,
			pendingOperation: null,
		});
		expect(manager.isActive()).toBe(false);
	});
});
