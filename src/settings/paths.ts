import { isAbsolute, join, resolve } from "node:path";
import { createProjectKey } from "../storage/ids";
import type { InstructionName } from "./schema";

export interface SettingsPathInput {
	agentDir: string;
	cwd: string;
	extensionName: string;
}

export interface SettingsPaths {
	extensionName: string;
	agentDir: string;
	cwd: string;
	globalDir: string;
	globalSettings: string;
	globalState: string;
	globalInstructionsDir: string;
	projectDir: string;
	projectSettings: string;
	projectInstructionsDir: string;
	projectState: string;
}

export function createSettingsPaths(input: SettingsPathInput): SettingsPaths {
	const globalDir = join(input.agentDir, "extensions", input.extensionName);
	const projectDir = join(input.cwd, ".pi", "extensions", input.extensionName);
	const projectStateDir = join(
		globalDir,
		"projects",
		createProjectKey(input.cwd),
	);

	return {
		extensionName: input.extensionName,
		agentDir: input.agentDir,
		cwd: input.cwd,
		globalDir,
		globalSettings: join(globalDir, "settings.json"),
		globalState: join(globalDir, "state.json"),
		globalInstructionsDir: join(globalDir, "instructions"),
		projectDir,
		projectSettings: join(projectDir, "settings.json"),
		projectInstructionsDir: join(projectDir, "instructions"),
		projectState: join(projectStateDir, "state.json"),
	};
}

export function resolveConfiguredPath(baseDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function instructionFileName(name: InstructionName): string {
	return `${name}.md`;
}
