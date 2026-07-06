import { sha256 } from "../hash";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import { loadBundledVrfTemplates } from "./defaults";
import {
	planVrfTemplatesDir,
	projectVrfTemplatesDir,
	vrfTemplateFilePath,
} from "./paths";
import {
	type SyncedVrfTemplate,
	VRF_TEMPLATE_NAMES,
	type VrfTemplateContents,
} from "./schema";

/**
 * Materialize the premise-template library into the plan's elenchus dir
 * (`<planDir>/elenchus/templates/`). A project-local override
 * (`.pi/pi-code-planner/vrf/<name>.vrf`) replaces the bundled default of the
 * same name. Content-hash comparison keeps the sync idempotent, and a stale
 * copy is refreshed on the next call — so calling this lazily before every
 * check is cheap and self-healing.
 */
export async function syncVrfTemplatesToPlan(
	fs: PlannerFs,
	input: {
		projectPaths: ProjectStoragePaths;
		planPaths: PlanStoragePaths;
		bundledDir?: string;
	},
): Promise<SyncedVrfTemplate[]> {
	const bundled = await loadBundledVrfTemplates(fs, input.bundledDir);
	const overridesDir = projectVrfTemplatesDir(input.projectPaths);
	const targetDir = planVrfTemplatesDir(input.planPaths);
	await fs.mkdirp(targetDir);

	const results: SyncedVrfTemplate[] = [];
	for (const name of VRF_TEMPLATE_NAMES) {
		const overridePath = vrfTemplateFilePath(overridesDir, name);
		const hasOverride = await fs.exists(overridePath);
		const content = hasOverride
			? await fs.readText(overridePath)
			: (bundled as VrfTemplateContents)[name];
		const targetPath = vrfTemplateFilePath(targetDir, name);
		const action = await writeIfChanged(fs, targetPath, content);
		results.push({
			name,
			targetPath,
			source: hasOverride ? "project" : "bundled",
			action,
		});
	}
	return results;
}

async function writeIfChanged(
	fs: PlannerFs,
	path: string,
	content: string,
): Promise<SyncedVrfTemplate["action"]> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, content);
		return "created";
	}
	const current = await fs.readText(path);
	if (sha256(current) === sha256(content)) {
		return "unchanged";
	}
	await fs.writeTextAtomic(path, content);
	return "updated";
}
