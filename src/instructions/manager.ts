import { createHash } from "node:crypto";
import type { PlannerFs } from "../storage/fs";
import { instructionFilePath } from "./paths";
import {
	INSTRUCTION_KEYS,
	type InstructionContent,
	type InstructionDefaults,
	type InstructionKey,
	type InstructionPaths,
	type SyncedInstructionFile,
} from "./schema";

export async function syncInstructionFiles(
	fs: PlannerFs,
	paths: InstructionPaths,
	defaults: InstructionDefaults,
): Promise<SyncedInstructionFile[]> {
	await fs.mkdirp(paths.defaultsDir);
	await fs.mkdirp(paths.globalAppendDir);

	const results: SyncedInstructionFile[] = [];
	for (const key of INSTRUCTION_KEYS) {
		const defaultPath = instructionFilePath(paths.defaultsDir, key);
		const globalAppendPath = instructionFilePath(paths.globalAppendDir, key);
		const defaultContent = defaults[key];
		const defaultAction = await syncDefaultInstruction(
			fs,
			defaultPath,
			defaultContent,
		);
		const globalAppendAction = await ensureGlobalAppendPlaceholder(
			fs,
			globalAppendPath,
		);

		results.push({
			key,
			defaultPath,
			globalAppendPath,
			defaultAction,
			globalAppendAction,
		});
	}

	return results;
}

export async function readInstructionDefaultsFromDir(
	fs: PlannerFs,
	defaultsDir: string,
): Promise<InstructionDefaults> {
	const defaults = {} as InstructionDefaults;
	for (const key of INSTRUCTION_KEYS) {
		defaults[key] = await fs.readText(instructionFilePath(defaultsDir, key));
	}
	return defaults;
}

export async function getInstructionContent(
	fs: PlannerFs,
	paths: InstructionPaths,
	key: InstructionKey,
): Promise<InstructionContent> {
	const defaultPath = instructionFilePath(paths.defaultsDir, key);
	const defaultContent = await fs.readText(defaultPath);
	const append = await readSelectedAppend(fs, paths, key);

	return {
		key,
		defaultPath,
		appendPath: append.path,
		appendSource: append.source,
		content: joinInstructionParts(defaultContent, append.content),
	};
}

async function syncDefaultInstruction(
	fs: PlannerFs,
	path: string,
	content: string,
): Promise<SyncedInstructionFile["defaultAction"]> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, content);
		return "created";
	}

	const current = await fs.readText(path);
	if (hashText(current) === hashText(content)) {
		return "unchanged";
	}

	await fs.writeTextAtomic(path, content);
	return "updated";
}

async function ensureGlobalAppendPlaceholder(
	fs: PlannerFs,
	path: string,
): Promise<SyncedInstructionFile["globalAppendAction"]> {
	if (await fs.exists(path)) {
		return "unchanged";
	}
	await fs.writeTextAtomic(path, "");
	return "created";
}

async function readSelectedAppend(
	fs: PlannerFs,
	paths: InstructionPaths,
	key: InstructionKey,
): Promise<{
	source: InstructionContent["appendSource"];
	path: string | null;
	content: string;
}> {
	const projectAppendPath = instructionFilePath(paths.projectAppendDir, key);
	if (await fs.exists(projectAppendPath)) {
		return {
			source: "project",
			path: projectAppendPath,
			content: await fs.readText(projectAppendPath),
		};
	}

	const globalAppendPath = instructionFilePath(paths.globalAppendDir, key);
	if (await fs.exists(globalAppendPath)) {
		return {
			source: "global",
			path: globalAppendPath,
			content: await fs.readText(globalAppendPath),
		};
	}

	return { source: null, path: null, content: "" };
}

function joinInstructionParts(
	defaultContent: string,
	appendContent: string,
): string {
	if (appendContent.trim().length === 0) {
		return defaultContent;
	}
	return `${defaultContent.trimEnd()}\n\n${appendContent.trimStart()}`;
}

function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
