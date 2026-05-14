import { join } from "node:path";

export function toProjectDirName(projectPath: string): string {
	return projectPath.replace(/^\/+/, "").replace(/\//g, "-");
}

export function getProjectPlansDir(
	basePlansDir: string,
	projectPath: string,
): string {
	return join(basePlansDir, toProjectDirName(projectPath));
}
