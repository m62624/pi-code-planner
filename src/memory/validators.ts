import type {
	MemoryFileEntry,
	MemoryFileKind,
	MemoryFileStatus,
	MemoryRelationEntry,
	MemoryRelationKind,
	MemorySymbolEntry,
	MemorySymbolGlobalState,
	MemorySymbolKind,
	MemorySymbolVisibility,
	MemoryVerificationStatus,
} from "./schema";

const FILE_KINDS = [
	"source",
	"test",
	"config",
	"docs",
	"generated",
	"vendor",
	"unknown",
] as const satisfies readonly MemoryFileKind[];

const FILE_STATUSES = [
	"pending",
	"indexed",
	"dirty",
	"ignored",
	"missing",
	"failed",
] as const satisfies readonly MemoryFileStatus[];

const SYMBOL_KINDS = [
	"function",
	"method",
	"type",
	"class",
	"trait",
	"interface",
	"module",
	"constant",
	"test",
	"unknown",
] as const satisfies readonly MemorySymbolKind[];

const SYMBOL_VISIBILITIES = [
	"public",
	"package",
	"crate",
	"private",
	"test_only",
	"unknown",
] as const satisfies readonly MemorySymbolVisibility[];

const SYMBOL_GLOBAL_STATES = [
	"none",
	"reads",
	"writes",
	"unknown",
] as const satisfies readonly MemorySymbolGlobalState[];

const VERIFICATION_STATUSES = [
	"verified",
	"stale",
	"missing",
	"unverified",
] as const satisfies readonly MemoryVerificationStatus[];

const RELATION_KINDS = [
	"calls",
	"implements",
	"extends",
	"contains",
	"returns",
	"accepts",
	"throws",
	"reads",
	"writes",
	"tests",
	"configures",
	"depends_on",
	"exposes",
	"unknown",
] as const satisfies readonly MemoryRelationKind[];

export interface MemoryValidationFailure {
	reasons: string[];
}

export type MemoryValidationResult<T> =
	| { ok: true; entry: T }
	| { ok: false; reasons: string[] };

export function validateMemoryFileEntry(
	value: unknown,
): MemoryValidationResult<MemoryFileEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "path", reasons);
	requiredEnum(value, "kind", FILE_KINDS, reasons);
	requiredString(value, "language", reasons);
	requiredString(value, "hash", reasons);
	requiredEnum(value, "status", FILE_STATUSES, reasons);
	requiredString(value, "summary", reasons);
	rejectUnsafePath(value.path, "path", reasons);

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemoryFileEntry }
		: { ok: false, reasons };
}

export function validateMemorySymbolEntry(
	value: unknown,
): MemoryValidationResult<MemorySymbolEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "id", reasons);
	requiredString(value, "path", reasons);
	requiredString(value, "language", reasons);
	requiredEnum(value, "kind", SYMBOL_KINDS, reasons);
	requiredString(value, "name", reasons);
	requiredString(value, "qualifiedName", reasons);
	requiredString(value, "signature", reasons);
	requiredString(value, "summary", reasons);
	requiredEnum(value, "visibility", SYMBOL_VISIBILITIES, reasons);
	rejectUnsafePath(value.path, "path", reasons);

	if (!isRecord(value.effects)) {
		reasons.push("effects must be an object.");
	} else {
		requiredStringArray(value.effects, "reads", reasons);
		requiredStringArray(value.effects, "writes", reasons);
		requiredStringArray(value.effects, "io", reasons);
		requiredEnum(value.effects, "globalState", SYMBOL_GLOBAL_STATES, reasons);
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
		requiredEnum(value.verification, "status", VERIFICATION_STATUSES, reasons);
	}

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemorySymbolEntry }
		: { ok: false, reasons };
}

export function validateMemoryRelationEntry(
	value: unknown,
): MemoryValidationResult<MemoryRelationEntry> {
	const reasons: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, reasons: ["Entry must be an object."] };
	}

	requiredString(value, "id", reasons);
	requiredString(value, "from", reasons);
	if (!(typeof value.to === "string" || value.to === null)) {
		reasons.push("to must be a string or null.");
	}
	requiredEnum(value, "kind", RELATION_KINDS, reasons);
	requiredString(value, "evidencePath", reasons);
	requiredString(value, "evidenceSearchText", reasons);
	rejectUnsafePath(value.evidencePath, "evidencePath", reasons);

	return reasons.length === 0
		? { ok: true, entry: value as unknown as MemoryRelationEntry }
		: { ok: false, reasons };
}

export function isMemoryFileEntry(value: unknown): value is MemoryFileEntry {
	return validateMemoryFileEntry(value).ok;
}

export function isMemorySymbolEntry(
	value: unknown,
): value is MemorySymbolEntry {
	return validateMemorySymbolEntry(value).ok;
}

export function isMemoryRelationEntry(
	value: unknown,
): value is MemoryRelationEntry {
	return validateMemoryRelationEntry(value).ok;
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

function requiredEnum<T extends string>(
	record: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	reasons: string[],
): void {
	const value = record[key];
	if (typeof value !== "string" || value === "") {
		reasons.push(`${key} must be a non-empty string.`);
		return;
	}
	if (!(allowed as readonly string[]).includes(value)) {
		reasons.push(`${key} has unsupported value: ${value}.`);
	}
}

function rejectUnsafePath(
	value: unknown,
	key: string,
	reasons: string[],
): void {
	if (hasAbsolutePath(value)) {
		reasons.push(`${key} must be relative, not absolute.`);
	}
	if (hasParentTraversal(value)) {
		reasons.push(`${key} must not contain parent traversal.`);
	}
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
