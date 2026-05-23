import type { PlannerFs } from "../storage/fs";
import {
	markMemoryDirty,
	readFileIndex,
	readMemoryDirtyState,
	readRelationIndex,
	readSymbolIndex,
	replaceFileIndex,
	replaceSymbolIndex,
} from "./manager";
import type { MemoryStoragePaths } from "./paths";
import type {
	MemoryDirtyState,
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";

export interface MemoryProjectFileSnapshotEntry {
	path: string;
	hash: string;
}

export interface MemoryFreshnessInput {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	currentFiles: readonly MemoryProjectFileSnapshotEntry[];
}

export interface MemoryFreshnessApplyInput extends MemoryFreshnessInput {
	detectedAt: string;
}

export interface MemoryFreshnessResult {
	clean: boolean;
	unchangedFiles: string[];
	changedFiles: string[];
	missingFiles: string[];
	newFiles: string[];
	affectedSymbolIds: string[];
	affectedRelationIds: string[];
	filesToReindex: string[];
}

export interface MemoryFreshnessApplyResult extends MemoryFreshnessResult {
	dirty: MemoryDirtyState;
}

export async function analyzeMemoryFreshness(
	input: MemoryFreshnessInput,
): Promise<MemoryFreshnessResult> {
	const current = normalizeSnapshot(input.currentFiles);
	const fileIndex = await readFileIndex(input.fs, input.paths);
	const symbolIndex = await readSymbolIndex(input.fs, input.paths);
	const relationIndex = await readRelationIndex(input.fs, input.paths);
	const indexed = new Map(fileIndex.map((entry) => [entry.path, entry]));

	const unchangedFiles: string[] = [];
	const changedFiles: string[] = [];
	const missingFiles: string[] = [];
	const newFiles: string[] = [];

	for (const entry of fileIndex) {
		const actualHash = current.get(entry.path);
		if (actualHash === undefined) {
			missingFiles.push(entry.path);
		} else if (actualHash !== entry.hash) {
			changedFiles.push(entry.path);
		} else {
			unchangedFiles.push(entry.path);
		}
	}

	for (const [path] of current) {
		if (!indexed.has(path)) {
			newFiles.push(path);
		}
	}

	const affectedFiles = new Set([
		...changedFiles,
		...missingFiles,
		...newFiles,
	]);
	const affectedSymbolIds = affectedSymbols(symbolIndex, affectedFiles);
	const affectedRelationIds = affectedRelations(
		relationIndex,
		affectedFiles,
		new Set(affectedSymbolIds),
	);
	const filesToReindex = [...affectedFiles].sort();

	return {
		clean: filesToReindex.length === 0,
		unchangedFiles: unchangedFiles.sort(),
		changedFiles: changedFiles.sort(),
		missingFiles: missingFiles.sort(),
		newFiles: newFiles.sort(),
		affectedSymbolIds,
		affectedRelationIds,
		filesToReindex,
	};
}

export async function applyMemoryFreshness(
	input: MemoryFreshnessApplyInput,
): Promise<MemoryFreshnessApplyResult> {
	const analysis = await analyzeMemoryFreshness(input);
	const fileIndex = await readFileIndex(input.fs, input.paths);
	const symbolIndex = await readSymbolIndex(input.fs, input.paths);
	const changed = new Set(analysis.changedFiles);
	const missing = new Set(analysis.missingFiles);

	await replaceFileIndex(
		input.fs,
		input.paths,
		fileIndex.map((entry) => markFileEntryFreshness(entry, changed, missing)),
	);
	await replaceSymbolIndex(
		input.fs,
		input.paths,
		symbolIndex.map((entry) =>
			markSymbolEntryFreshness(entry, changed, missing),
		),
	);

	let dirty = await readMemoryDirtyState(input.fs, input.paths);
	if (analysis.changedFiles.length > 0 || analysis.newFiles.length > 0) {
		dirty = await markMemoryDirty(input.fs, input.paths, {
			files: [...analysis.changedFiles, ...analysis.newFiles],
			reason: "file_hash_changed",
			detectedAt: input.detectedAt,
		});
	}
	if (analysis.missingFiles.length > 0) {
		dirty = await markMemoryDirty(input.fs, input.paths, {
			files: analysis.missingFiles,
			reason: "verification_failed",
			detectedAt: input.detectedAt,
		});
	}

	return {
		...analysis,
		dirty,
	};
}

function normalizeSnapshot(
	entries: readonly MemoryProjectFileSnapshotEntry[],
): Map<string, string> {
	const normalized = new Map<string, string>();
	for (const entry of entries) {
		assertRelativeMemoryPath(entry.path);
		if (entry.hash.trim().length === 0) {
			throw new TypeError(`Snapshot hash must be non-empty for ${entry.path}.`);
		}
		normalized.set(entry.path, entry.hash);
	}
	return normalized;
}

function assertRelativeMemoryPath(path: string): void {
	if (path.trim().length === 0) {
		throw new TypeError("Snapshot path must be non-empty.");
	}
	if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
		throw new TypeError(`Snapshot path must be relative: ${path}`);
	}
	if (path.split(/[\\/]/).includes("..")) {
		throw new TypeError(
			`Snapshot path must not contain parent traversal: ${path}`,
		);
	}
}

function affectedSymbols(
	symbols: readonly MemorySymbolEntry[],
	affectedFiles: ReadonlySet<string>,
): string[] {
	return symbols
		.filter((entry) => affectedFiles.has(entry.path))
		.map((entry) => entry.id)
		.sort();
}

function affectedRelations(
	relations: readonly MemoryRelationEntry[],
	affectedFiles: ReadonlySet<string>,
	affectedSymbolIds: ReadonlySet<string>,
): string[] {
	return relations
		.filter(
			(entry) =>
				affectedFiles.has(entry.evidencePath) ||
				affectedSymbolIds.has(entry.from) ||
				(entry.to !== null && affectedSymbolIds.has(entry.to)),
		)
		.map((entry) => entry.id)
		.sort();
}

function markFileEntryFreshness(
	entry: MemoryFileEntry,
	changed: ReadonlySet<string>,
	missing: ReadonlySet<string>,
): MemoryFileEntry {
	if (missing.has(entry.path)) {
		return { ...entry, status: "missing" };
	}
	if (changed.has(entry.path)) {
		return { ...entry, status: "dirty" };
	}
	return entry;
}

function markSymbolEntryFreshness(
	entry: MemorySymbolEntry,
	changed: ReadonlySet<string>,
	missing: ReadonlySet<string>,
): MemorySymbolEntry {
	if (missing.has(entry.path)) {
		return {
			...entry,
			verification: { ...entry.verification, status: "missing" },
		};
	}
	if (changed.has(entry.path)) {
		return {
			...entry,
			verification: { ...entry.verification, status: "stale" },
		};
	}
	return entry;
}
