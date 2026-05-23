import { createHash } from "node:crypto";
import type { PlannerFs } from "../storage/fs";
import { readJson, readJsonIfExists, writeJson } from "../storage/json";
import type { PlanStoragePaths } from "../storage/paths";
import {
	type JsonlValidator,
	readJsonl,
	removeJsonlEntries,
	upsertJsonlEntries,
	writeJsonl,
} from "./jsonl";
import { createMemoryStoragePaths, type MemoryStoragePaths } from "./paths";
import type {
	MemoryCheckpoint,
	MemoryCheckpointVerification,
	MemoryDirtyReason,
	MemoryDirtyState,
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";

export async function initializeMemoryFiles(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<MemoryStoragePaths> {
	const paths = createMemoryStoragePaths(planPaths);
	await fs.mkdirp(paths.filesDir);
	await fs.mkdirp(paths.symbolsDir);
	await fs.mkdirp(paths.relationsDir);
	await fs.mkdirp(paths.checkpointsDir);
	await ensureText(fs, paths.projectPatternsMd, "");
	await ensureText(fs, paths.filesIndexJsonl, "");
	await ensureText(fs, paths.symbolsIndexJsonl, "");
	await ensureText(fs, paths.relationsIndexJsonl, "");
	if (!(await fs.exists(paths.dirtyJson))) {
		await writeJson(fs, paths.dirtyJson, createEmptyDirtyState());
	}
	if (!(await fs.exists(paths.latestCheckpointJson))) {
		await writeMemoryCheckpoint(fs, paths, null);
	}
	return paths;
}

export async function readProjectPatterns(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<string> {
	if (!(await fs.exists(paths.projectPatternsMd))) {
		return "";
	}
	return await fs.readText(paths.projectPatternsMd);
}

export async function writeProjectPatterns(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	content: string,
): Promise<void> {
	await fs.writeTextAtomic(paths.projectPatternsMd, content);
}

export async function readFileIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryFileEntry[]> {
	return await readJsonl(fs, paths.filesIndexJsonl, isMemoryFileEntry);
}

export async function replaceFileIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemoryFileEntry[],
): Promise<void> {
	validateEntries(entries, isMemoryFileEntry, "file index");
	await writeJsonl(fs, paths.filesIndexJsonl, entries);
}

export async function upsertFileEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemoryFileEntry[],
): Promise<MemoryFileEntry[]> {
	validateEntries(entries, isMemoryFileEntry, "file index");
	const next = upsertJsonlEntries(
		await readFileIndex(fs, paths),
		entries,
		(entry) => entry.path,
	);
	await writeJsonl(fs, paths.filesIndexJsonl, next);
	return next;
}

export async function removeFileEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	pathsToRemove: readonly string[],
): Promise<MemoryFileEntry[]> {
	const next = removeJsonlEntries(
		await readFileIndex(fs, paths),
		pathsToRemove,
		(entry) => entry.path,
	);
	await writeJsonl(fs, paths.filesIndexJsonl, next);
	return next;
}

export async function readSymbolIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemorySymbolEntry[]> {
	return await readJsonl(fs, paths.symbolsIndexJsonl, isMemorySymbolEntry);
}

export async function replaceSymbolIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemorySymbolEntry[],
): Promise<void> {
	validateEntries(entries, isMemorySymbolEntry, "symbol index");
	await writeJsonl(fs, paths.symbolsIndexJsonl, entries);
}

export async function upsertSymbolEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemorySymbolEntry[],
): Promise<MemorySymbolEntry[]> {
	validateEntries(entries, isMemorySymbolEntry, "symbol index");
	const next = upsertJsonlEntries(
		await readSymbolIndex(fs, paths),
		entries,
		(entry) => entry.id,
	);
	await writeJsonl(fs, paths.symbolsIndexJsonl, next);
	return next;
}

export async function removeSymbolEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	ids: readonly string[],
): Promise<MemorySymbolEntry[]> {
	const next = removeJsonlEntries(
		await readSymbolIndex(fs, paths),
		ids,
		(entry) => entry.id,
	);
	await writeJsonl(fs, paths.symbolsIndexJsonl, next);
	return next;
}

export async function readRelationIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryRelationEntry[]> {
	return await readJsonl(fs, paths.relationsIndexJsonl, isMemoryRelationEntry);
}

export async function replaceRelationIndex(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemoryRelationEntry[],
): Promise<void> {
	validateEntries(entries, isMemoryRelationEntry, "relation index");
	await writeJsonl(fs, paths.relationsIndexJsonl, entries);
}

export async function upsertRelationEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	entries: readonly MemoryRelationEntry[],
): Promise<MemoryRelationEntry[]> {
	validateEntries(entries, isMemoryRelationEntry, "relation index");
	const next = upsertJsonlEntries(
		await readRelationIndex(fs, paths),
		entries,
		(entry) => entry.id,
	);
	await writeJsonl(fs, paths.relationsIndexJsonl, next);
	return next;
}

export async function removeRelationEntries(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	ids: readonly string[],
): Promise<MemoryRelationEntry[]> {
	const next = removeJsonlEntries(
		await readRelationIndex(fs, paths),
		ids,
		(entry) => entry.id,
	);
	await writeJsonl(fs, paths.relationsIndexJsonl, next);
	return next;
}

export async function readMemoryDirtyState(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryDirtyState> {
	return (
		(await readJsonIfExists<MemoryDirtyState>(fs, paths.dirtyJson)) ??
		createEmptyDirtyState()
	);
}

export async function markMemoryDirty(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	input: {
		files: readonly string[];
		reason: MemoryDirtyReason;
		detectedAt: string;
	},
): Promise<MemoryDirtyState> {
	const current = await readMemoryDirtyState(fs, paths);
	const files = { ...current.files };
	for (const file of input.files) {
		files[file] = {
			reason: input.reason,
			detectedAt: input.detectedAt,
		};
	}
	const next = { files };
	await writeJson(fs, paths.dirtyJson, next);
	return next;
}

export async function clearMemoryDirty(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	filesToClear: readonly string[],
): Promise<MemoryDirtyState> {
	const current = await readMemoryDirtyState(fs, paths);
	const files = { ...current.files };
	for (const file of filesToClear) {
		delete files[file];
	}
	const next = { files };
	await writeJson(fs, paths.dirtyJson, next);
	return next;
}

export async function writeMemoryCheckpoint(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	commit: string | null,
): Promise<MemoryCheckpoint> {
	const checkpoint = await computeMemoryCheckpoint(fs, paths, commit);
	await writeJson(fs, paths.latestCheckpointJson, checkpoint);
	return checkpoint;
}

export async function readMemoryCheckpoint(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryCheckpoint> {
	return await readJson<MemoryCheckpoint>(fs, paths.latestCheckpointJson);
}

export async function verifyMemoryCheckpoint(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryCheckpointVerification> {
	const expected = await readMemoryCheckpoint(fs, paths);
	const actual = await computeMemoryCheckpoint(fs, paths, expected.commit);
	const mismatches = checkpointMismatches(expected, actual);
	return {
		valid: mismatches.length === 0,
		expected,
		actual,
		mismatches,
	};
}

export async function computeMemoryCheckpoint(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	commit: string | null,
): Promise<MemoryCheckpoint> {
	return {
		commit,
		filesIndexHash: await hashTextFile(fs, paths.filesIndexJsonl),
		symbolsIndexHash: await hashTextFile(fs, paths.symbolsIndexJsonl),
		relationsIndexHash: await hashTextFile(fs, paths.relationsIndexJsonl),
	};
}

function createEmptyDirtyState(): MemoryDirtyState {
	return { files: {} };
}

async function ensureText(
	fs: PlannerFs,
	path: string,
	content: string,
): Promise<void> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, content);
	}
}

async function hashTextFile(fs: PlannerFs, path: string): Promise<string> {
	const text = (await fs.exists(path)) ? await fs.readText(path) : "";
	return createHash("sha256").update(text).digest("hex");
}

function checkpointMismatches(
	expected: MemoryCheckpoint,
	actual: MemoryCheckpoint,
): string[] {
	const mismatches: string[] = [];
	if (expected.commit !== actual.commit) {
		mismatches.push("commit");
	}
	if (expected.filesIndexHash !== actual.filesIndexHash) {
		mismatches.push("filesIndexHash");
	}
	if (expected.symbolsIndexHash !== actual.symbolsIndexHash) {
		mismatches.push("symbolsIndexHash");
	}
	if (expected.relationsIndexHash !== actual.relationsIndexHash) {
		mismatches.push("relationsIndexHash");
	}
	return mismatches;
}

function validateEntries<T>(
	entries: readonly unknown[],
	validate: JsonlValidator<T>,
	label: string,
): asserts entries is readonly T[] {
	for (const entry of entries) {
		if (!validate(entry)) {
			throw new TypeError(`Invalid ${label} entry.`);
		}
	}
}

function isMemoryFileEntry(value: unknown): value is MemoryFileEntry {
	return (
		isRecord(value) &&
		isString(value.path) &&
		isString(value.kind) &&
		isString(value.language) &&
		isString(value.hash) &&
		isString(value.status) &&
		isString(value.summary)
	);
}

function isMemorySymbolEntry(value: unknown): value is MemorySymbolEntry {
	return (
		isRecord(value) &&
		isString(value.id) &&
		isString(value.path) &&
		isString(value.language) &&
		isString(value.kind) &&
		isString(value.name) &&
		isString(value.qualifiedName) &&
		isString(value.signature) &&
		isString(value.summary) &&
		isString(value.visibility) &&
		isRecord(value.effects) &&
		isStringArray(value.effects.reads) &&
		isStringArray(value.effects.writes) &&
		isStringArray(value.effects.io) &&
		isString(value.effects.globalState) &&
		isRecord(value.anchor) &&
		isString(value.anchor.searchText) &&
		isRecord(value.verification) &&
		isString(value.verification.fileHash) &&
		isString(value.verification.status)
	);
}

function isMemoryRelationEntry(value: unknown): value is MemoryRelationEntry {
	return (
		isRecord(value) &&
		isString(value.id) &&
		isString(value.from) &&
		(isString(value.to) || value.to === null) &&
		isString(value.kind) &&
		isString(value.evidencePath) &&
		isString(value.evidenceSearchText)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}
