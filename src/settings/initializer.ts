import { join } from "node:path";
import { DEFAULT_INSTRUCTION_CONTENT, DEFAULT_SETTINGS } from "./defaults";
import type { PlannerFs } from "./fs";
import { writeJsonAtomic } from "./fs";
import type { SettingsPaths } from "./paths";
import { instructionFileName } from "./paths";
import { INSTRUCTION_NAMES } from "./schema";

export interface InitResult {
	created: string[];
	existing: string[];
}

export function ensurePlannerFiles(
	paths: SettingsPaths,
	fs: PlannerFs,
): InitResult {
	const created: string[] = [];
	const existing: string[] = [];

	fs.mkdirp(paths.globalDir);
	fs.mkdirp(paths.globalInstructionsDir);

	if (!fs.exists(paths.globalSettings)) {
		writeJsonAtomic(fs, paths.globalSettings, DEFAULT_SETTINGS);
		created.push(paths.globalSettings);
	} else {
		existing.push(paths.globalSettings);
	}

	for (const name of INSTRUCTION_NAMES) {
		const path = join(paths.globalInstructionsDir, instructionFileName(name));
		if (!fs.exists(path)) {
			fs.writeFile(path, DEFAULT_INSTRUCTION_CONTENT[name]);
			created.push(path);
		} else {
			existing.push(path);
		}
	}

	return { created, existing };
}
