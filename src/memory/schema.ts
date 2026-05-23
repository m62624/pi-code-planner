export type MemoryFileKind =
	| "source"
	| "test"
	| "config"
	| "docs"
	| "generated"
	| "vendor"
	| "unknown";

export type MemoryFileStatus =
	| "pending"
	| "indexed"
	| "dirty"
	| "ignored"
	| "missing"
	| "failed";

export interface MemoryFileEntry {
	path: string;
	kind: MemoryFileKind;
	language: string;
	hash: string;
	status: MemoryFileStatus;
	summary: string;
}

export type MemorySymbolKind =
	| "function"
	| "method"
	| "type"
	| "class"
	| "trait"
	| "interface"
	| "module"
	| "constant"
	| "test"
	| "unknown";

export type MemorySymbolVisibility =
	| "public"
	| "package"
	| "crate"
	| "private"
	| "test_only"
	| "unknown";

export type MemorySymbolGlobalState = "none" | "reads" | "writes" | "unknown";

export interface MemorySymbolEffects {
	reads: string[];
	writes: string[];
	io: string[];
	globalState: MemorySymbolGlobalState;
}

export type MemoryVerificationStatus =
	| "verified"
	| "stale"
	| "missing"
	| "unverified";

export interface MemorySymbolEntry {
	id: string;
	path: string;
	language: string;
	kind: MemorySymbolKind;
	name: string;
	qualifiedName: string;
	signature: string;
	summary: string;
	visibility: MemorySymbolVisibility;
	effects: MemorySymbolEffects;
	anchor: {
		searchText: string;
	};
	verification: {
		fileHash: string;
		status: MemoryVerificationStatus;
	};
}

export type MemoryRelationKind =
	| "calls"
	| "implements"
	| "extends"
	| "contains"
	| "returns"
	| "accepts"
	| "throws"
	| "reads"
	| "writes"
	| "tests"
	| "configures"
	| "depends_on"
	| "exposes"
	| "unknown";

export interface MemoryRelationEntry {
	id: string;
	from: string;
	to: string | null;
	kind: MemoryRelationKind;
	evidencePath: string;
	evidenceSearchText: string;
}

export type MemoryDirtyReason =
	| "file_hash_changed"
	| "git_status_changed"
	| "external_commit"
	| "rebase_or_history_rewrite"
	| "manual_checkout"
	| "symbol_missing"
	| "verification_failed";

export interface MemoryDirtyFile {
	reason: MemoryDirtyReason;
	detectedAt: string;
}

export interface MemoryDirtyState {
	files: Record<string, MemoryDirtyFile>;
}

export interface MemoryCheckpoint {
	commit: string | null;
	filesIndexHash: string;
	symbolsIndexHash: string;
	relationsIndexHash: string;
}

export interface MemoryCheckpointVerification {
	valid: boolean;
	expected: MemoryCheckpoint;
	actual: MemoryCheckpoint;
	mismatches: string[];
}
