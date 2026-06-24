import { createHash } from "node:crypto";
import type { PlannerFs } from "../storage/fs";
import { instructionFilePath } from "./paths";
import {
	INSTRUCTION_KEYS,
	type InstructionContent,
	type InstructionDefaults,
	type InstructionKey,
	type InstructionPaths,
	type InstructionSection,
	type InstructionSectionName,
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

export async function getInstructionSectionContent(
	fs: PlannerFs,
	paths: InstructionPaths,
	key: InstructionKey,
	sectionName: InstructionSectionName,
): Promise<InstructionContent & { section: InstructionSection }> {
	const content = await getInstructionContent(fs, paths, key);
	return {
		...content,
		section: getInstructionSection(content.content, sectionName),
	};
}

export function getInstructionSection(
	content: string,
	sectionName: InstructionSectionName,
): InstructionSection {
	const sections = parseInstructionSections(content);
	const section = sections.get(normalizeSectionName(sectionName));
	return {
		name: sectionName,
		content: section?.trim() ?? "",
		found: section !== undefined,
	};
}

export function parseInstructionSections(content: string): Map<string, string> {
	const sections = new Map<string, string>();
	let currentName: string | null = null;
	let currentLines: string[] = [];

	for (const line of content.split(/\r?\n/)) {
		const heading = parseLevelTwoHeading(line);
		if (heading) {
			flushSection(sections, currentName, currentLines);
			currentName = heading;
			currentLines = [];
			continue;
		}

		if (currentName) {
			currentLines.push(line);
		}
	}

	flushSection(sections, currentName, currentLines);
	return sections;
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

// Project and global append are NOT merged together — project, if present,
// is used exclusively and global is ignored. A user's global append text
// silently stops applying once a project-level append file is created for
// the same key.
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

function parseLevelTwoHeading(line: string): string | null {
	const match = /^##\s+(.+)$/.exec(line);
	if (!match) {
		return null;
	}
	const raw = match[1];
	if (!raw || raw.startsWith("#")) {
		return null;
	}
	return normalizeSectionName(raw);
}

function normalizeSectionName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function flushSection(
	sections: Map<string, string>,
	name: string | null,
	lines: readonly string[],
): void {
	if (!name) {
		return;
	}
	sections.set(name, lines.join("\n").trim());
}
