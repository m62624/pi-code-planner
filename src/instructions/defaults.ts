import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannerFs } from "../storage/fs";
import {
	readInstructionDefaultsFromDir,
	syncInstructionFiles,
} from "./manager";
import type {
	InstructionDefaults,
	InstructionPaths,
	SyncedInstructionFile,
} from "./schema";

export const BUNDLED_INSTRUCTION_DEFAULTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"instructions",
	"defaults",
);

export async function loadBundledInstructionDefaults(
	fs: PlannerFs,
	defaultsDir = BUNDLED_INSTRUCTION_DEFAULTS_DIR,
): Promise<InstructionDefaults> {
	return await readInstructionDefaultsFromDir(fs, defaultsDir);
}

export async function syncBundledInstructionFiles(
	fs: PlannerFs,
	paths: InstructionPaths,
	defaultsDir = BUNDLED_INSTRUCTION_DEFAULTS_DIR,
): Promise<SyncedInstructionFile[]> {
	const defaults = await loadBundledInstructionDefaults(fs, defaultsDir);
	return await syncInstructionFiles(fs, paths, defaults);
}
