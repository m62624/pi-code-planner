import { RuntimeStateManager } from "../planner-state/runtime";
import type { PlannerFs } from "../settings/fs";
import { createNodeFs } from "../settings/fs";
import { ensurePlannerFiles } from "../settings/initializer";
import { loadPlannerSettings } from "../settings/loader";
import {
	createSettingsPaths,
	type SettingsPathInput,
	type SettingsPaths,
} from "../settings/paths";
import type { SettingsLoadResult } from "../settings/schema";
import { validateBranchNamingSettings } from "./branch-naming";
import { GitMutations } from "./mutations";
import {
	createGitPreflightService,
	type GitPreflightService,
} from "./preflight";
import { type GitRunner, NodeGitRunner } from "./runner";
import { getRepoState, type RepoState } from "./state";
import { type GitWriter, RunnerGitWriter } from "./write";

export interface GitCoreOptions extends SettingsPathInput {
	fs?: PlannerFs;
	runner?: GitRunner;
	writer?: GitWriter;
}

export interface GitCore {
	paths: SettingsPaths;
	fs: PlannerFs;
	settings: SettingsLoadResult;
	state: RuntimeStateManager;
	runner: GitRunner;
	writer: GitWriter;
	mutations: GitMutations;
	preflight: GitPreflightService;
	readRepoState(): Promise<RepoState>;
}

export function createGitCore(options: GitCoreOptions): GitCore {
	const fs = options.fs ?? createNodeFs();
	const paths = createSettingsPaths(options);
	ensurePlannerFiles(paths, fs);

	const settings = loadPlannerSettings(paths, fs);
	validateBranchNamingSettings(settings.settings.git.branchNaming);

	const state = new RuntimeStateManager({
		paths: { projectDir: paths.projectDir, projectState: paths.projectState },
		fs,
	});
	state.initialize();

	const runner = options.runner ?? new NodeGitRunner();
	const writer = options.writer ?? new RunnerGitWriter(runner, options.cwd);
	const readRepoState = () => getRepoState(runner, options.cwd);
	const mutations = new GitMutations({
		state,
		writer,
		branchNaming: settings.settings.git.branchNaming,
		readRepoState,
	});
	const preflight = createGitPreflightService({ state, readRepoState });

	return {
		paths,
		fs,
		settings,
		state,
		runner,
		writer,
		mutations,
		preflight,
		readRepoState,
	};
}
