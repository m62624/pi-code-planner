import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import type { PlannerFs } from "../settings/fs";
import { writeJsonAtomic } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import { shortHash } from "../storage/ids";
import { appendJsonl, readJsonl, upsertJsonlByKey, writeJsonl } from "./jsonl";
import {
	getProjectMemoryPaths,
	getRelationShardPath,
	getSymbolShardPath,
} from "./paths";
import type {
	DeletedMemoryEntry,
	DirtyMemoryState,
	FileEntry,
	MemoryIndexes,
	MemoryManifest,
	SymbolEntry,
	SymbolRelation,
} from "./schema";
import { EMPTY_DIRTY_MEMORY_STATE, EMPTY_MEMORY_INDEXES } from "./schema";

export interface ProjectMemoryStoreOptions {
	paths: Pick<SettingsPaths, "globalDir">;
	fs: PlannerFs;
	projectPath: string;
	now?: () => string;
}

export interface SymbolSearchQuery {
	name?: string;
	kind?: string;
	filePath?: string;
	text?: string;
	limit?: number;
}

export interface SymbolContext {
	symbol: SymbolEntry;
	relations: SymbolRelation[];
	relatedSymbols: SymbolEntry[];
}

export interface VerifySymbolResult {
	symbol: SymbolEntry;
	found: boolean;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function normalizeSearchText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function readJsonFile<T>(fs: PlannerFs, path: string, fallback: T): T {
	if (!fs.exists(path)) return fallback;
	return JSON.parse(fs.readFile(path)) as T;
}

function addIndexValue(
	index: Record<string, string[]>,
	key: string,
	value: string,
): void {
	index[key] = unique([...(index[key] ?? []), value]);
}

function removeIndexValue(
	index: Record<string, string[]>,
	key: string,
	value: string,
): void {
	const next = (index[key] ?? []).filter((candidate) => candidate !== value);
	if (next.length === 0) {
		delete index[key];
		return;
	}
	index[key] = next;
}

export class ProjectMemoryStore {
	private now: () => string;

	constructor(private options: ProjectMemoryStoreOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	initialize(): MemoryManifest {
		const paths = getProjectMemoryPaths(this.options);
		this.options.fs.mkdirp(paths.filesDir);
		this.options.fs.mkdirp(paths.symbolsDir);
		this.options.fs.mkdirp(paths.relationsDir);
		this.options.fs.mkdirp(paths.indexesDir);
		this.options.fs.mkdirp(paths.deletedDir);

		if (!this.options.fs.exists(paths.projectSummary)) {
			this.options.fs.writeFile(paths.projectSummary, "");
		}
		if (!this.options.fs.exists(paths.projectPatterns)) {
			this.options.fs.writeFile(paths.projectPatterns, "");
		}
		if (!this.options.fs.exists(paths.openQuestions)) {
			this.options.fs.writeFile(paths.openQuestions, "");
		}
		if (!this.options.fs.exists(paths.libraryVersions)) {
			this.options.fs.writeFile(paths.libraryVersions, "{}\n");
		}
		if (!this.options.fs.exists(paths.filesIndex)) {
			writeJsonl(this.options.fs, paths.filesIndex, []);
		}
		this.saveIndexes(this.loadIndexes());
		this.saveDirty(this.loadDirty());

		const manifest = this.loadManifest();
		this.saveManifest(manifest);
		return manifest;
	}

	loadManifest(): MemoryManifest {
		const paths = getProjectMemoryPaths(this.options);
		if (this.options.fs.exists(paths.manifest)) {
			return JSON.parse(
				this.options.fs.readFile(paths.manifest),
			) as MemoryManifest;
		}
		const now = this.now();
		return {
			version: 1,
			projectPath: normalize(this.options.projectPath),
			createdAt: now,
			updatedAt: now,
			counts: {
				files: 0,
				symbols: 0,
				relations: 0,
				dirtyFiles: 0,
			},
		};
	}

	upsertFiles(entries: FileEntry[]): FileEntry[] {
		this.initialize();
		const paths = getProjectMemoryPaths(this.options);
		const now = this.now();
		const nextEntries = entries.map((entry) => ({
			...entry,
			filePath: normalize(entry.filePath),
			updatedAt: entry.updatedAt || now,
		}));
		const files = upsertJsonlByKey(
			this.options.fs,
			paths.filesIndex,
			nextEntries,
			(entry) => entry.filePath,
		);
		this.refreshManifest();
		return files;
	}

	readFiles(): FileEntry[] {
		this.initialize();
		const paths = getProjectMemoryPaths(this.options);
		return readJsonl<FileEntry>(this.options.fs, paths.filesIndex);
	}

	upsertSymbols(entries: SymbolEntry[]): SymbolEntry[] {
		this.initialize();
		const paths = getProjectMemoryPaths(this.options);
		const indexes = this.loadIndexes();
		const now = this.now();
		const byShard = new Map<string, SymbolEntry[]>();
		const previousSymbols = new Map<string, SymbolEntry>();
		for (const entry of this.readAllSymbols()) {
			previousSymbols.set(entry.id, entry);
		}

		for (const entry of entries) {
			const normalized = this.normalizeSymbol(entry, now);
			const previous = previousSymbols.get(normalized.id);
			if (previous) {
				removeIndexValue(indexes.byFile, previous.filePath, previous.id);
				removeIndexValue(indexes.byName, previous.name, previous.id);
				removeIndexValue(indexes.byKind, previous.kind, previous.id);
			}
			addIndexValue(indexes.byFile, normalized.filePath, normalized.id);
			addIndexValue(indexes.byName, normalized.name, normalized.id);
			addIndexValue(indexes.byKind, normalized.kind, normalized.id);

			const shardPath = getSymbolShardPath(paths, normalized.filePath);
			const previousShardPath = indexes.symbolShards[normalized.id];
			if (previousShardPath && previousShardPath !== shardPath) {
				writeJsonl(
					this.options.fs,
					previousShardPath,
					readJsonl<SymbolEntry>(this.options.fs, previousShardPath).filter(
						(candidate) => candidate.id !== normalized.id,
					),
				);
			}
			indexes.symbolShards[normalized.id] = shardPath;
			byShard.set(shardPath, [...(byShard.get(shardPath) ?? []), normalized]);
		}

		for (const [shardPath, shardEntries] of byShard) {
			upsertJsonlByKey(
				this.options.fs,
				shardPath,
				shardEntries,
				(entry) => entry.id,
			);
		}

		this.saveIndexes(indexes);
		this.refreshManifest();
		return this.readAllSymbols();
	}

	searchSymbols(query: SymbolSearchQuery): SymbolEntry[] {
		this.initialize();
		const indexes = this.loadIndexes();
		let ids: string[] | null = null;
		if (query.filePath) {
			ids = indexes.byFile[normalize(query.filePath)] ?? [];
		}
		if (query.name) {
			const nameIds = indexes.byName[query.name] ?? [];
			ids = ids === null ? nameIds : ids.filter((id) => nameIds.includes(id));
		}
		if (query.kind) {
			const kindIds = indexes.byKind[query.kind] ?? [];
			ids = ids === null ? kindIds : ids.filter((id) => kindIds.includes(id));
		}

		const symbols =
			ids === null
				? this.readAllSymbols()
				: ids.map((id) => this.getSymbol(id)).filter((entry) => entry !== null);
		const text = query.text?.toLowerCase();
		const filtered = text
			? symbols.filter((entry) =>
					[
						entry.name,
						entry.qualifiedName ?? "",
						entry.signature,
						entry.summary,
					]
						.join("\n")
						.toLowerCase()
						.includes(text),
				)
			: symbols;
		return filtered.slice(0, query.limit ?? 50);
	}

	getSymbolsByFile(filePath: string): SymbolEntry[] {
		return this.searchSymbols({ filePath, limit: Number.MAX_SAFE_INTEGER });
	}

	getSymbol(id: string): SymbolEntry | null {
		this.initialize();
		const indexes = this.loadIndexes();
		const shardPath = indexes.symbolShards[id];
		if (!shardPath) return null;
		return (
			readJsonl<SymbolEntry>(this.options.fs, shardPath).find(
				(entry) => entry.id === id,
			) ?? null
		);
	}

	deleteSymbol(symbolId: string, reason: string): boolean {
		this.initialize();
		const indexes = this.loadIndexes();
		const shardPath = indexes.symbolShards[symbolId];
		if (!shardPath) return false;
		const entries = readJsonl<SymbolEntry>(this.options.fs, shardPath);
		const previous = entries.find((entry) => entry.id === symbolId);
		if (!previous) return false;

		writeJsonl(
			this.options.fs,
			shardPath,
			entries.filter((entry) => entry.id !== symbolId),
		);
		removeIndexValue(indexes.byFile, previous.filePath, symbolId);
		removeIndexValue(indexes.byName, previous.name, symbolId);
		removeIndexValue(indexes.byKind, previous.kind, symbolId);
		delete indexes.symbolShards[symbolId];
		this.saveIndexes(indexes);

		const paths = getProjectMemoryPaths(this.options);
		appendJsonl<DeletedMemoryEntry>(this.options.fs, paths.deletedSymbols, [
			{
				id: symbolId,
				deletedAt: this.now(),
				reason,
				previous,
			},
		]);
		this.refreshManifest();
		return true;
	}

	upsertRelations(entries: SymbolRelation[]): SymbolRelation[] {
		this.initialize();
		const paths = getProjectMemoryPaths(this.options);
		const indexes = this.loadIndexes();
		const now = this.now();
		const byShard = new Map<string, SymbolRelation[]>();

		for (const entry of entries) {
			const normalized: SymbolRelation = {
				...entry,
				id:
					entry.id ||
					`rel_${shortHash(
						`${entry.fromSymbolId}:${entry.toSymbolId}:${entry.kind}:${entry.evidenceFilePath}:${entry.evidenceSearchText}`,
						16,
					)}`,
				evidenceFilePath: normalize(entry.evidenceFilePath),
				updatedAt: entry.updatedAt || now,
			};
			const shardPath = getRelationShardPath(
				paths,
				normalized.evidenceFilePath,
			);
			const previousShardPath = indexes.relationShards[normalized.id];
			if (previousShardPath && previousShardPath !== shardPath) {
				writeJsonl(
					this.options.fs,
					previousShardPath,
					readJsonl<SymbolRelation>(this.options.fs, previousShardPath).filter(
						(candidate) => candidate.id !== normalized.id,
					),
				);
			}
			indexes.relationShards[normalized.id] = shardPath;
			byShard.set(shardPath, [...(byShard.get(shardPath) ?? []), normalized]);
		}

		for (const [shardPath, shardEntries] of byShard) {
			upsertJsonlByKey(
				this.options.fs,
				shardPath,
				shardEntries,
				(entry) => entry.id,
			);
		}

		this.saveIndexes(indexes);
		this.refreshManifest();
		return this.readAllRelations();
	}

	getRelations(symbolId: string): SymbolRelation[] {
		this.initialize();
		return this.readAllRelations().filter(
			(relation) =>
				relation.fromSymbolId === symbolId || relation.toSymbolId === symbolId,
		);
	}

	deleteRelation(relationId: string, reason: string): boolean {
		this.initialize();
		const indexes = this.loadIndexes();
		const shardPath = indexes.relationShards[relationId];
		if (!shardPath) return false;
		const entries = readJsonl<SymbolRelation>(this.options.fs, shardPath);
		const previous = entries.find((entry) => entry.id === relationId);
		if (!previous) return false;

		writeJsonl(
			this.options.fs,
			shardPath,
			entries.filter((entry) => entry.id !== relationId),
		);
		delete indexes.relationShards[relationId];
		this.saveIndexes(indexes);

		const paths = getProjectMemoryPaths(this.options);
		appendJsonl<DeletedMemoryEntry>(this.options.fs, paths.deletedRelations, [
			{
				id: relationId,
				deletedAt: this.now(),
				reason,
				previous,
			},
		]);
		this.refreshManifest();
		return true;
	}

	getSymbolContext(symbolId: string): SymbolContext | null {
		const symbol = this.getSymbol(symbolId);
		if (!symbol) return null;
		const relations = this.getRelations(symbolId);
		const relatedSymbols = relations
			.flatMap((relation) => [relation.fromSymbolId, relation.toSymbolId])
			.filter((id): id is string => Boolean(id) && id !== symbolId)
			.map((id) => this.getSymbol(id))
			.filter((entry): entry is SymbolEntry => entry !== null);
		return {
			symbol,
			relations,
			relatedSymbols,
		};
	}

	markFilesDirty(filePaths: string[], reason: string): DirtyMemoryState {
		this.initialize();
		const dirty = this.loadDirty();
		const markedAt = this.now();
		for (const filePath of filePaths) {
			const normalized = normalize(filePath);
			dirty.files[normalized] = {
				filePath: normalized,
				reason,
				markedAt,
			};
		}
		this.saveDirty(dirty);
		this.updateFilesStatus(filePaths, "dirty");
		this.refreshManifest();
		return dirty;
	}

	clearDirtyFiles(filePaths: string[]): DirtyMemoryState {
		this.initialize();
		const dirty = this.loadDirty();
		for (const filePath of filePaths) {
			const normalized = normalize(filePath);
			delete dirty.files[normalized];
			const normalizedPrefix = normalized.endsWith("/")
				? normalized
				: `${normalized}/`;
			for (const dirtyPath of Object.keys(dirty.files)) {
				const prefix = dirtyPath.endsWith("/") ? dirtyPath : `${dirtyPath}/`;
				if (
					normalized.startsWith(prefix) ||
					dirtyPath.startsWith(normalizedPrefix)
				) {
					delete dirty.files[dirtyPath];
				}
			}
		}
		this.saveDirty(dirty);
		this.refreshManifest();
		return dirty;
	}

	getDirtyFiles(): DirtyMemoryState {
		this.initialize();
		return this.loadDirty();
	}

	verifySymbol(symbolId: string): VerifySymbolResult | null {
		const symbol = this.getSymbol(symbolId);
		if (!symbol) return null;
		const found = this.searchTextExists(
			symbol.filePath,
			symbol.anchors.searchText,
		);
		const next: SymbolEntry = {
			...symbol,
			evidence: {
				...symbol.evidence,
				fileHash: this.fileHash(symbol.filePath),
				verifiedAt: this.now(),
				verificationStatus: found ? "verified" : "missing",
			},
			updatedAt: this.now(),
		};
		this.upsertSymbols([next]);
		return { symbol: next, found };
	}

	verifyFile(filePath: string): VerifySymbolResult[] {
		return this.getSymbolsByFile(filePath)
			.map((symbol) => this.verifySymbol(symbol.id))
			.filter((result): result is VerifySymbolResult => result !== null);
	}

	readAllSymbols(): SymbolEntry[] {
		this.initialize();
		const indexes = this.loadIndexes();
		return unique(Object.values(indexes.symbolShards)).flatMap((shardPath) =>
			readJsonl<SymbolEntry>(this.options.fs, shardPath),
		);
	}

	readAllRelations(): SymbolRelation[] {
		this.initialize();
		const indexes = this.loadIndexes();
		return unique(Object.values(indexes.relationShards)).flatMap((shardPath) =>
			readJsonl<SymbolRelation>(this.options.fs, shardPath),
		);
	}

	private updateFilesStatus(
		filePaths: string[],
		indexStatus: FileEntry["indexStatus"],
	): void {
		const files = this.readFiles();
		const wanted = new Set(filePaths.map((filePath) => normalize(filePath)));
		const next = files.map((file) =>
			wanted.has(file.filePath) ? { ...file, indexStatus } : file,
		);
		const paths = getProjectMemoryPaths(this.options);
		writeJsonl(this.options.fs, paths.filesIndex, next);
	}

	private normalizeSymbol(entry: SymbolEntry, now: string): SymbolEntry {
		const filePath = normalize(entry.filePath);
		const searchText = entry.anchors.searchText || entry.signature;
		return {
			...entry,
			id:
				entry.id ||
				`sym_${shortHash(
					`${filePath}:${entry.qualifiedName ?? entry.name}:${entry.kind}:${entry.signature}`,
					16,
				)}`,
			filePath,
			anchors: {
				...entry.anchors,
				searchText,
				normalizedSignature:
					entry.anchors.normalizedSignature ||
					normalizeSearchText(entry.signature),
			},
			evidence: {
				...entry.evidence,
				fileHash: entry.evidence.fileHash ?? this.fileHash(filePath),
				searchTextHash:
					entry.evidence.searchTextHash ||
					hashText(normalizeSearchText(searchText)),
			},
			updatedAt: entry.updatedAt || now,
		};
	}

	private searchTextExists(filePath: string, searchText: string): boolean {
		const absolute = join(this.options.projectPath, filePath);
		if (!this.options.fs.exists(absolute)) return false;
		const content = this.options.fs.readFile(absolute);
		return (
			content.includes(searchText) ||
			normalizeSearchText(content).includes(normalizeSearchText(searchText))
		);
	}

	private fileHash(filePath: string): string | null {
		const absolute = join(this.options.projectPath, filePath);
		if (!this.options.fs.exists(absolute)) return null;
		return hashText(this.options.fs.readFile(absolute));
	}

	private loadIndexes(): MemoryIndexes {
		const paths = getProjectMemoryPaths(this.options);
		return {
			...EMPTY_MEMORY_INDEXES,
			byFile: readJsonFile(this.options.fs, paths.byFileIndex, {}),
			byName: readJsonFile(this.options.fs, paths.byNameIndex, {}),
			byKind: readJsonFile(this.options.fs, paths.byKindIndex, {}),
			symbolShards: readJsonFile(this.options.fs, paths.symbolShardsIndex, {}),
			relationShards: readJsonFile(
				this.options.fs,
				paths.relationShardsIndex,
				{},
			),
		};
	}

	private saveIndexes(indexes: MemoryIndexes): void {
		const paths = getProjectMemoryPaths(this.options);
		writeJsonAtomic(this.options.fs, paths.byFileIndex, indexes.byFile);
		writeJsonAtomic(this.options.fs, paths.byNameIndex, indexes.byName);
		writeJsonAtomic(this.options.fs, paths.byKindIndex, indexes.byKind);
		writeJsonAtomic(
			this.options.fs,
			paths.symbolShardsIndex,
			indexes.symbolShards,
		);
		writeJsonAtomic(
			this.options.fs,
			paths.relationShardsIndex,
			indexes.relationShards,
		);
	}

	private loadDirty(): DirtyMemoryState {
		const paths = getProjectMemoryPaths(this.options);
		return readJsonFile(this.options.fs, paths.dirty, {
			...EMPTY_DIRTY_MEMORY_STATE,
			files: {},
		});
	}

	private saveDirty(dirty: DirtyMemoryState): void {
		const paths = getProjectMemoryPaths(this.options);
		writeJsonAtomic(this.options.fs, paths.dirty, dirty);
	}

	private saveManifest(manifest: MemoryManifest): void {
		const paths = getProjectMemoryPaths(this.options);
		writeJsonAtomic(this.options.fs, paths.manifest, manifest);
	}

	private refreshManifest(): MemoryManifest {
		const previous = this.loadManifest();
		const dirty = this.loadDirty();
		const next: MemoryManifest = {
			...previous,
			updatedAt: this.now(),
			counts: {
				files: this.readFiles().length,
				symbols: this.readAllSymbols().length,
				relations: this.readAllRelations().length,
				dirtyFiles: Object.keys(dirty.files).length,
			},
		};
		this.saveManifest(next);
		return next;
	}
}
