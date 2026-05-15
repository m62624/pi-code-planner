import type { PlannerFs } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import { ProjectMemoryStore } from "./store";

export interface MemoryCoreOptions {
	paths: Pick<SettingsPaths, "globalDir">;
	fs: PlannerFs;
	projectPath: string;
}

export interface MemoryCore {
	store: ProjectMemoryStore;
}

export function createMemoryCore(options: MemoryCoreOptions): MemoryCore {
	const store = new ProjectMemoryStore({
		paths: options.paths,
		fs: options.fs,
		projectPath: options.projectPath,
	});
	store.initialize();
	return { store };
}
