import type { PlannerFs } from "../storage/fs";
import {
	readFileIndex,
	readSymbolIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
} from "./manager";
import type { MemoryStoragePaths } from "./paths";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";
import {
	validateMemoryFileEntry,
	validateMemoryRelationEntry,
	validateMemorySymbolEntry,
} from "./validators";

export type MemoryBatchEntryKind = "file" | "symbol" | "relation";

export interface MemoryBatchRejectedEntry {
	kind: MemoryBatchEntryKind;
	index: number;
	id: string | null;
	reasons: string[];
}

export interface MemoryBatchWriteResult {
	accepted: {
		files: MemoryFileEntry[];
		symbols: MemorySymbolEntry[];
		relations: MemoryRelationEntry[];
	};
	rejected: MemoryBatchRejectedEntry[];
	totals: {
		input: number;
		accepted: number;
		rejected: number;
	};
}

export async function writeMemoryBatch(input: {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	files?: readonly unknown[];
	symbols?: readonly unknown[];
	relations?: readonly unknown[];
}): Promise<MemoryBatchWriteResult> {
	const result = collectValidMemoryBatch(input);
	await persistAcceptedBatch(input.fs, input.paths, result.accepted);
	return result;
}

export async function writeMemoryBatchWithReferences(input: {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	files?: readonly unknown[];
	symbols?: readonly unknown[];
	relations?: readonly unknown[];
}): Promise<MemoryBatchWriteResult> {
	const result = collectValidMemoryBatch(input);
	const filePaths = new Set([
		...(await readFileIndex(input.fs, input.paths)).map((entry) => entry.path),
		...result.accepted.files.map((entry) => entry.path),
	]);
	const symbolIds = new Set([
		...(await readSymbolIndex(input.fs, input.paths)).map((entry) => entry.id),
		...result.accepted.symbols.map((entry) => entry.id),
	]);

	const acceptedRelationInputs = (input.relations ?? [])
		.map((entry, index) => ({
			index,
			result: validateMemoryRelationEntry(entry),
		}))
		.filter(
			(
				item,
			): item is {
				index: number;
				result: { ok: true; entry: MemoryRelationEntry };
			} => item.result.ok,
		);
	const acceptedRelations: MemoryRelationEntry[] = [];
	for (const { index, result: relationResult } of acceptedRelationInputs) {
		const relation = relationResult.entry;
		const reasons: string[] = [];
		if (!symbolIds.has(relation.from)) {
			reasons.push(`Relation from symbol does not exist: ${relation.from}`);
		}
		if (relation.to !== null && !symbolIds.has(relation.to)) {
			reasons.push(`Relation to symbol does not exist: ${relation.to}`);
		}
		if (!filePaths.has(relation.evidencePath)) {
			reasons.push(
				`Relation evidence file does not exist in memory file index: ${relation.evidencePath}`,
			);
		}
		if (reasons.length > 0) {
			result.rejected.push({
				kind: "relation",
				index,
				id: relation.id,
				reasons,
			});
		} else {
			acceptedRelations.push(relation);
		}
	}
	result.accepted.relations = acceptedRelations;

	await persistAcceptedBatch(input.fs, input.paths, result.accepted);
	return withUpdatedTotals(result);
}

function collectValidMemoryBatch(input: {
	files?: readonly unknown[];
	symbols?: readonly unknown[];
	relations?: readonly unknown[];
}): MemoryBatchWriteResult {
	const accepted = {
		files: [] as MemoryFileEntry[],
		symbols: [] as MemorySymbolEntry[],
		relations: [] as MemoryRelationEntry[],
	};
	const rejected: MemoryBatchRejectedEntry[] = [];

	for (const [index, entry] of (input.files ?? []).entries()) {
		const result = validateMemoryFileEntry(entry);
		if (result.ok) {
			accepted.files.push(result.entry);
		} else {
			rejected.push({
				kind: "file",
				index,
				id: idOf(entry, "path"),
				reasons: result.reasons,
			});
		}
	}

	for (const [index, entry] of (input.symbols ?? []).entries()) {
		const result = validateMemorySymbolEntry(entry);
		if (result.ok) {
			accepted.symbols.push(result.entry);
		} else {
			rejected.push({
				kind: "symbol",
				index,
				id: idOf(entry, "id"),
				reasons: result.reasons,
			});
		}
	}

	for (const [index, entry] of (input.relations ?? []).entries()) {
		const result = validateMemoryRelationEntry(entry);
		if (result.ok) {
			accepted.relations.push(result.entry);
		} else {
			rejected.push({
				kind: "relation",
				index,
				id: idOf(entry, "id"),
				reasons: result.reasons,
			});
		}
	}

	const acceptedCount =
		accepted.files.length + accepted.symbols.length + accepted.relations.length;
	const rejectedCount = rejected.length;
	return {
		accepted,
		rejected,
		totals: {
			input: acceptedCount + rejectedCount,
			accepted: acceptedCount,
			rejected: rejectedCount,
		},
	};
}

async function persistAcceptedBatch(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	accepted: MemoryBatchWriteResult["accepted"],
): Promise<void> {
	if (accepted.files.length > 0) {
		await upsertFileEntries(fs, paths, accepted.files);
	}
	if (accepted.symbols.length > 0) {
		await upsertSymbolEntries(fs, paths, accepted.symbols);
	}
	if (accepted.relations.length > 0) {
		await upsertRelationEntries(fs, paths, accepted.relations);
	}
}

function withUpdatedTotals(
	result: MemoryBatchWriteResult,
): MemoryBatchWriteResult {
	const acceptedCount =
		result.accepted.files.length +
		result.accepted.symbols.length +
		result.accepted.relations.length;
	return {
		...result,
		totals: {
			input: acceptedCount + result.rejected.length,
			accepted: acceptedCount,
			rejected: result.rejected.length,
		},
	};
}

export async function validateMemoryBatchAgainstIndexes(input: {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	files?: readonly unknown[];
	symbols?: readonly unknown[];
	relations?: readonly unknown[];
}): Promise<MemoryBatchWriteResult> {
	return await writeMemoryBatchWithReferences(input);
}

function idOf(value: unknown, key: string): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = value[key];
	return typeof id === "string" && id ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
