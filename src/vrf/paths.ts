import { join } from "node:path";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import type { VrfTemplateName } from "./schema";

/** Directory of per-project template overrides (same file name wins). */
export function projectVrfTemplatesDir(
	projectPaths: ProjectStoragePaths,
): string {
	return join(projectPaths.projectLocalDir, "vrf");
}

/**
 * Where templates are materialized for a plan. Living inside the plan's
 * elenchus dir keeps the IMPORT resolver sandbox intact and the plan dir
 * self-contained (a stored check reproduces with elenchus-cli as-is).
 */
export function planVrfTemplatesDir(planPaths: PlanStoragePaths): string {
	return join(planPaths.elenchusDir, "templates");
}

export function vrfTemplateFilePath(
	dir: string,
	name: VrfTemplateName,
): string {
	return join(dir, `${name}.vrf`);
}

/** The IMPORT path a model program uses to pull in a template. */
export function vrfTemplateImportPath(name: VrfTemplateName): string {
	return `templates/${name}.vrf`;
}
