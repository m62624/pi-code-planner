import { DEFAULT_SETTINGS } from "./defaults";
import type { PlannerFs } from "./fs";
import { mergePlannerSettings } from "./merge";
import type { SettingsPaths } from "./paths";
import { resolveConfiguredPath } from "./paths";
import {
	INSTRUCTION_NAMES,
	type InstructionName,
	type PartialPlannerSettings,
	type SettingsLoadResult,
} from "./schema";

function readJsonIfExists(
	fs: PlannerFs,
	path: string,
): PartialPlannerSettings | null {
	if (!fs.exists(path)) return null;
	return JSON.parse(fs.readFile(path)) as PartialPlannerSettings;
}

function selectInstructionSource(
	fs: PlannerFs,
	paths: SettingsPaths,
	settingsPath: string,
): string {
	const projectCandidate = resolveConfiguredPath(
		paths.projectDir,
		settingsPath,
	);
	if (fs.exists(projectCandidate)) return projectCandidate;

	const globalCandidate = resolveConfiguredPath(paths.globalDir, settingsPath);
	return globalCandidate;
}

export function loadPlannerSettings(
	paths: SettingsPaths,
	fs: PlannerFs,
): SettingsLoadResult {
	let settings = structuredClone(DEFAULT_SETTINGS);
	const sources: SettingsLoadResult["sources"] = {
		defaults: "built-in",
		instructions: {},
	};

	const globalSettings = readJsonIfExists(fs, paths.globalSettings);
	if (globalSettings) {
		settings = mergePlannerSettings(settings, globalSettings);
		sources.globalSettings = paths.globalSettings;
	}

	const projectSettings = readJsonIfExists(fs, paths.projectSettings);
	if (projectSettings) {
		settings = mergePlannerSettings(settings, projectSettings);
		sources.projectSettings = paths.projectSettings;
	}

	for (const name of INSTRUCTION_NAMES) {
		sources.instructions[name] = selectInstructionSource(
			fs,
			paths,
			settings.instructions[name],
		);
	}

	return { settings, sources };
}

export function getInstructionContent(
	loadResult: SettingsLoadResult,
	fs: PlannerFs,
	name: InstructionName,
): string {
	const source = loadResult.sources.instructions[name];
	if (!source) {
		throw new Error(`Instruction source not resolved: ${name}`);
	}
	return fs.readFile(source);
}
