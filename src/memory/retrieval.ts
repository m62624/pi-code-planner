import type { PlannerFs } from "../storage/fs";
import {
	readFileIndex,
	readMemoryDirtyState,
	readProjectPatterns,
	readRelationIndex,
	readSymbolIndex,
} from "./manager";
import type { MemoryStoragePaths } from "./paths";
import type {
	MemoryDirtyState,
	MemoryFileEntry,
	MemoryRelationEntry,
	MemoryRelationKind,
	MemorySymbolEntry,
	MemorySymbolGlobalState,
	MemorySymbolKind,
	MemoryVerificationStatus,
} from "./schema";

export const DEFAULT_MEMORY_RETRIEVAL_LIMIT = 20;
export const MAX_MEMORY_RETRIEVAL_LIMIT = 100;

export interface MemoryRetrievalCursor {
	files?: number;
	symbols?: number;
	relations?: number;
}

export interface MemoryRetrievalLimits {
	files?: number;
	symbols?: number;
	relations?: number;
}

export interface MemoryRetrievalFilters {
	paths?: readonly string[];
	languages?: readonly string[];
	symbolKinds?: readonly MemorySymbolKind[];
	relationKinds?: readonly MemoryRelationKind[];
	globalState?: readonly MemorySymbolGlobalState[];
	verificationStatus?: readonly MemoryVerificationStatus[];
	dirtyOnly?: boolean;
}

export interface MemoryRetrievalInput {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	query?: string;
	cursor?: MemoryRetrievalCursor;
	limits?: MemoryRetrievalLimits;
	filters?: MemoryRetrievalFilters;
	includeProjectPatterns?: boolean;
	includeDirtyState?: boolean;
}

export interface MemoryRetrievalPage<T> {
	entries: T[];
	totalMatched: number;
	start: number;
	limit: number;
	nextCursor: number | null;
}

export interface MemoryRetrievalResult {
	projectPatterns?: string;
	dirty?: MemoryDirtyState;
	files: MemoryRetrievalPage<MemoryFileEntry>;
	symbols: MemoryRetrievalPage<MemorySymbolEntry>;
	relations: MemoryRetrievalPage<MemoryRelationEntry>;
}

export async function retrieveMemoryContext(
	input: MemoryRetrievalInput,
): Promise<MemoryRetrievalResult> {
	const dirty =
		input.filters?.dirtyOnly || input.includeDirtyState
			? await readMemoryDirtyState(input.fs, input.paths)
			: undefined;
	const files = filterFiles(
		await readFileIndex(input.fs, input.paths),
		input.query,
		input.filters,
		dirty,
	);
	const symbols = filterSymbols(
		await readSymbolIndex(input.fs, input.paths),
		input.query,
		input.filters,
		dirty,
	);
	const relations = filterRelations(
		await readRelationIndex(input.fs, input.paths),
		input.query,
		input.filters,
		dirty,
	);

	const result: MemoryRetrievalResult = {
		files: pageEntries(
			files,
			input.cursor?.files,
			clampLimit(input.limits?.files),
		),
		symbols: pageEntries(
			symbols,
			input.cursor?.symbols,
			clampLimit(input.limits?.symbols),
		),
		relations: pageEntries(
			relations,
			input.cursor?.relations,
			clampLimit(input.limits?.relations),
		),
	};

	if (input.includeProjectPatterns) {
		result.projectPatterns = await readProjectPatterns(input.fs, input.paths);
	}
	if (input.includeDirtyState) {
		result.dirty = dirty ?? (await readMemoryDirtyState(input.fs, input.paths));
	}

	return result;
}

function pageEntries<T>(
	entries: readonly T[],
	cursor: number | undefined,
	limit: number,
): MemoryRetrievalPage<T> {
	const start = Math.max(0, cursor ?? 0);
	const page = entries.slice(start, start + limit);
	const next = start + page.length;
	return {
		entries: page,
		totalMatched: entries.length,
		start,
		limit,
		nextCursor: next < entries.length ? next : null,
	};
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_MEMORY_RETRIEVAL_LIMIT;
	}
	return Math.min(MAX_MEMORY_RETRIEVAL_LIMIT, Math.max(1, Math.trunc(limit)));
}

function filterFiles(
	entries: readonly MemoryFileEntry[],
	query: string | undefined,
	filters: MemoryRetrievalFilters | undefined,
	dirty: MemoryDirtyState | undefined,
): MemoryFileEntry[] {
	const normalizedQuery = normalizeQuery(query);
	return entries
		.filter((entry) => matchesPathFilter(entry.path, filters?.paths))
		.filter((entry) => matchesText(normalizedQuery, fileSearchText(entry)))
		.filter((entry) => matchesStringFilter(entry.language, filters?.languages))
		.filter((entry) =>
			matchesDirtyFilter(entry.path, filters?.dirtyOnly, dirty),
		)
		.sort(compareByPath);
}

function filterSymbols(
	entries: readonly MemorySymbolEntry[],
	query: string | undefined,
	filters: MemoryRetrievalFilters | undefined,
	dirty: MemoryDirtyState | undefined,
): MemorySymbolEntry[] {
	const normalizedQuery = normalizeQuery(query);
	return entries
		.filter((entry) => matchesPathFilter(entry.path, filters?.paths))
		.filter((entry) => matchesText(normalizedQuery, symbolSearchText(entry)))
		.filter((entry) => matchesStringFilter(entry.language, filters?.languages))
		.filter((entry) => matchesStringFilter(entry.kind, filters?.symbolKinds))
		.filter((entry) =>
			matchesStringFilter(entry.effects.globalState, filters?.globalState),
		)
		.filter((entry) =>
			matchesStringFilter(
				entry.verification.status,
				filters?.verificationStatus,
			),
		)
		.filter((entry) =>
			matchesDirtyFilter(entry.path, filters?.dirtyOnly, dirty),
		)
		.sort(compareBySymbol);
}

function filterRelations(
	entries: readonly MemoryRelationEntry[],
	query: string | undefined,
	filters: MemoryRetrievalFilters | undefined,
	dirty: MemoryDirtyState | undefined,
): MemoryRelationEntry[] {
	const normalizedQuery = normalizeQuery(query);
	return entries
		.filter((entry) => matchesPathFilter(entry.evidencePath, filters?.paths))
		.filter((entry) => matchesText(normalizedQuery, relationSearchText(entry)))
		.filter((entry) => matchesStringFilter(entry.kind, filters?.relationKinds))
		.filter((entry) =>
			matchesDirtyFilter(entry.evidencePath, filters?.dirtyOnly, dirty),
		)
		.sort(compareByRelation);
}

function normalizeQuery(query: string | undefined): string {
	return (query ?? "").trim().toLowerCase();
}

function matchesText(query: string, text: string): boolean {
	return query.length === 0 || text.toLowerCase().includes(query);
}

function matchesPathFilter(
	path: string,
	paths: readonly string[] | undefined,
): boolean {
	return (
		paths === undefined ||
		paths.length === 0 ||
		paths.some(
			(candidate) => path === candidate || path.startsWith(`${candidate}/`),
		)
	);
}

function matchesStringFilter<T extends string>(
	value: T,
	allowed: readonly T[] | undefined,
): boolean {
	return (
		allowed === undefined || allowed.length === 0 || allowed.includes(value)
	);
}

function matchesDirtyFilter(
	path: string,
	dirtyOnly: boolean | undefined,
	dirty: MemoryDirtyState | undefined,
): boolean {
	return !dirtyOnly || dirty?.files[path] !== undefined;
}

function fileSearchText(entry: MemoryFileEntry): string {
	return [
		entry.path,
		entry.kind,
		entry.language,
		entry.status,
		entry.summary,
	].join("\n");
}

function symbolSearchText(entry: MemorySymbolEntry): string {
	return [
		entry.id,
		entry.path,
		entry.language,
		entry.kind,
		entry.name,
		entry.qualifiedName,
		entry.signature,
		entry.summary,
		entry.visibility,
		entry.effects.reads.join(" "),
		entry.effects.writes.join(" "),
		entry.effects.io.join(" "),
		entry.effects.globalState,
		entry.anchor.searchText,
		entry.verification.status,
	].join("\n");
}

function relationSearchText(entry: MemoryRelationEntry): string {
	return [
		entry.id,
		entry.from,
		entry.to ?? "",
		entry.kind,
		entry.evidencePath,
		entry.evidenceSearchText,
	].join("\n");
}

function compareByPath(a: MemoryFileEntry, b: MemoryFileEntry): number {
	return a.path.localeCompare(b.path);
}

function compareBySymbol(a: MemorySymbolEntry, b: MemorySymbolEntry): number {
	const pathOrder = a.path.localeCompare(b.path);
	return pathOrder === 0
		? a.qualifiedName.localeCompare(b.qualifiedName)
		: pathOrder;
}

function compareByRelation(
	a: MemoryRelationEntry,
	b: MemoryRelationEntry,
): number {
	const pathOrder = a.evidencePath.localeCompare(b.evidencePath);
	return pathOrder === 0 ? a.id.localeCompare(b.id) : pathOrder;
}
