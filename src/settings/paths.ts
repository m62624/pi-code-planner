import { join } from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";

export interface PlannerSettingsPaths {
	globalSettingsJson: string;
	projectSettingsJson: string;
}

export function createPlannerSettingsPaths(
	projectPaths: ProjectStoragePaths,
): PlannerSettingsPaths {
	return {
		globalSettingsJson: join(projectPaths.extensionDir, "settings.json"),
		projectSettingsJson: join(projectPaths.projectLocalDir, "settings.json"),
	};
}
