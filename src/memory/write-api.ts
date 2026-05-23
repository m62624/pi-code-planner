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

type ValidationResult<T> =
	| { ok: true; entry: T }
	| { ok: false; reasons: string[] };

function validateMemoryFileEntry(
	value: unknown,
): ValidationResult<MemoryFileEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "path", reasons);
	requiredString(value, "kind", reasons);
	requiredString(value, "language", reasons);
	requiredString(value, "hash", reasons);
	requiredString(value, "status", reasons);
	requiredString(value, "summary", reasons);
	if (hasAbsolutePath(value.path)) {
		reasons.push("path must be relative, not absolute.");
	}
	if (hasParentTraversal(value.path)) {
		reasons.push("path must not contain parent traversal.");
	}

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemoryFileEntry }
		: { ok: false, reasons };
}

function validateMemorySymbolEntry(
	value: unknown,
): ValidationResult<MemorySymbolEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "id", reasons);
	requiredString(value, "path", reasons);
	requiredString(value, "language", reasons);
	requiredString(value, "kind", reasons);
	requiredString(value, "name", reasons);
	requiredString(value, "qualifiedName", reasons);
	requiredString(value, "signature", reasons);
	requiredString(value, "summary", reasons);
	requiredString(value, "visibility", reasons);
	if (hasAbsolutePath(value.path)) {
		reasons.push("path must be relative, not absolute.");
	}
	if (hasParentTraversal(value.path)) {
		reasons.push("path must not contain parent traversal.");
	}

	if (!isRecord(value.effects)) {
		reasons.push("effects must be an object.");
	} else {
		requiredStringArray(value.effects, "reads", reasons);
		requiredStringArray(value.effects, "writes", reasons);
		requiredStringArray(value.effects, "io", reasons);
		requiredString(value.effects, "globalState", reasons);
	}

	if (!isRecord(value.anchor)) {
		reasons.push("anchor must be an object.");
	} else {
		requiredString(value.anchor, "searchText", reasons);
	}

	if (!isRecord(value.verification)) {
		reasons.push("verification must be an object.");
	} else {
		requiredString(value.verification, "fileHash", reasons);
		requiredString(value.verification, "status", reasons);
	}

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemorySymbolEntry }
		: { ok: false, reasons };
}

function validateMemoryRelationEntry(
	value: unknown,
): ValidationResult<MemoryRelationEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "id", reasons);
	requiredString(value, "from", reasons);
	if (!(typeof value.to === "string" || value.to === null)) {
		reasons.push("to must be a string or null.");
	}
	requiredString(value, "kind", reasons);
	requiredString(value, "evidencePath", reasons);
	requiredString(value, "evidenceSearchText", reasons);
	if (hasAbsolutePath(value.evidencePath)) {
		reasons.push("evidencePath must be relative, not absolute.");
	}
	if (hasParentTraversal(value.evidencePath)) {
		reasons.push("evidencePath must not contain parent traversal.");
	}

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemoryRelationEntry }
		: { ok: false, reasons };
}

function requiredString(
	record: Record<string, unknown>,
	key: string,
	reasons: string[],
): void {
	if (typeof record[key] !== "string" || record[key] === "") {
		reasons.push(`${key} must be a non-empty string.`);
	}
}

function requiredStringArray(
	record: Record<string, unknown>,
	key: string,
	reasons: string[],
): void {
	if (!Array.isArray(record[key]) || !record[key].every(isString)) {
		reasons.push(`${key} must be a string array.`);
	}
}

function idOf(value: unknown, key: string): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = value[key];
	return typeof id === "string" && id ? id : null;
}

function hasAbsolutePath(value: unknown): boolean {
	return typeof value === "string" && /^[/\\]|^[A-Za-z]:[\\/]/.test(value);
}

function hasParentTraversal(value: unknown): boolean {
	return (
		typeof value === "string" &&
		value.split(/[\\/]+/).some((part) => part === "..")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
