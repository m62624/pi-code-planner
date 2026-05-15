import { describe, expect, it } from "vitest";
import type { RepoState } from "../git/state";
import {
	emptyGitStatusSummary,
	type GitStatusSummary,
} from "../git/status-parser";
import {
	DEFAULT_PLANNER_RUNTIME_STATE,
	type PlannerRuntimeState,
} from "../planner-state/schema";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { syncDirtyMemoryFromRepo } from "./dirty-sync";
import { ProjectMemoryStore } from "./store";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createStore() {
	const fs = new MemoryFs();
	const store = new ProjectMemoryStore({
		paths,
		fs,
		projectPath: "/repo",
		now: () => "2026-05-15T00:00:00.000Z",
	});
	return { store };
}

function runtime(
	input: Partial<PlannerRuntimeState> = {},
): PlannerRuntimeState {
	return {
		...DEFAULT_PLANNER_RUNTIME_STATE,
		...input,
	};
}

function status(changes: Partial<GitStatusSummary> = {}): GitStatusSummary {
	const next = { ...emptyGitStatusSummary(), ...changes };
	next.hasStagedChanges = next.stagedFiles.length > 0;
	next.hasUnstagedChanges = next.unstagedFiles.length > 0;
	next.hasUntrackedFiles = next.untrackedFiles.length > 0;
	next.hasConflicts = next.conflictedFiles.length > 0;
	next.isDirty =
		next.hasStagedChanges ||
		next.hasUnstagedChanges ||
		next.hasUntrackedFiles ||
		next.hasConflicts;
	return next;
}

function repo(input: Partial<RepoState> = {}): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: "main",
		currentCommit: "commit-1",
		isDetachedHead: false,
		status: status(),
		...input,
	};
}

describe("syncDirtyMemoryFromRepo", () => {
	it("does not sync while planner is idle", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime(),
			memory: store,
			repo: repo({ status: status({ unstagedFiles: ["src/app.ts"] }) }),
			settings: DEFAULT_SETTINGS.memory,
		});

		expect(result.synced).toBe(false);
		expect(result.dirty.files).toEqual({});
	});

	it("does not sync when automatic tracking is disabled", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime({ mode: "plan_active", activePlanId: "plan-1" }),
			memory: store,
			repo: repo({ status: status({ unstagedFiles: ["src/app.ts"] }) }),
			settings: { ...DEFAULT_SETTINGS.memory, autoDirtyTracking: false },
		});

		expect(result.synced).toBe(false);
		expect(result.dirty.files).toEqual({});
	});

	it("marks git status paths dirty for an active planner", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime({ mode: "plan_active", activePlanId: "plan-1" }),
			memory: store,
			repo: repo({
				status: status({
					stagedFiles: ["src/app.ts"],
					unstagedFiles: ["src/app.ts", "./src/config.ts"],
					untrackedFiles: ["src/new.ts"],
					conflictedFiles: ["src/conflict.ts"],
					renamedFiles: ["src/renamed.ts"],
				}),
			}),
			settings: DEFAULT_SETTINGS.memory,
			reason: "git status sync",
		});

		expect(result.synced).toBe(true);
		expect(result.changedFiles).toEqual([
			"src/app.ts",
			"src/config.ts",
			"src/conflict.ts",
			"src/new.ts",
			"src/renamed.ts",
		]);
		expect(Object.keys(result.dirty.files).sort()).toEqual(result.changedFiles);
		expect(result.dirty.files["src/app.ts"].reason).toBe("git status sync");
	});

	it("filters configured ignored prefixes and absolute paths", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime({ mode: "plan_active", activePlanId: "plan-1" }),
			memory: store,
			repo: repo({
				status: status({
					unstagedFiles: [
						"src/app.ts",
						".pi/extensions/pi-planner/state.json",
						"/tmp/outside.ts",
					],
				}),
			}),
			settings: DEFAULT_SETTINGS.memory,
		});

		expect(result.synced).toBe(true);
		expect(result.changedFiles).toEqual(["src/app.ts"]);
		expect(Object.keys(result.dirty.files)).toEqual(["src/app.ts"]);
	});

	it("does not ignore project-specific build output unless git status hides it", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime({ mode: "plan_active", activePlanId: "plan-1" }),
			memory: store,
			repo: repo({
				status: status({
					untrackedFiles: ["dist/app.js", "coverage/coverage.json"],
				}),
			}),
			settings: DEFAULT_SETTINGS.memory,
		});

		expect(result.changedFiles).toEqual([
			"coverage/coverage.json",
			"dist/app.js",
		]);
	});

	it("does not sync outside a git repository", () => {
		const { store } = createStore();

		const result = syncDirtyMemoryFromRepo({
			plannerState: runtime({ mode: "plan_active", activePlanId: "plan-1" }),
			memory: store,
			repo: repo({
				isRepo: false,
				repoRoot: null,
				status: status({ unstagedFiles: ["src/app.ts"] }),
			}),
			settings: DEFAULT_SETTINGS.memory,
		});

		expect(result.synced).toBe(false);
		expect(result.dirty.files).toEqual({});
	});
});
