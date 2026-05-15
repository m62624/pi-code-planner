export type MemoryFileKind =
	| "source"
	| "test"
	| "config"
	| "docs"
	| "generated"
	| "vendor"
	| "unknown";

export type MemoryIndexStatus =
	| "pending"
	| "indexed"
	| "dirty"
	| "ignored"
	| "failed";

export type SymbolVisibility =
	| "public"
	| "package"
	| "crate"
	| "private"
	| "test_only"
	| "unknown";

export type SymbolStability =
	| "stable"
	| "internal"
	| "generated"
	| "deprecated"
	| "unknown";

export type SymbolVerificationStatus =
	| "verified"
	| "stale"
	| "missing"
	| "unverified";

export type SymbolRelationKind =
	| "calls"
	| "implements"
	| "extends"
	| "embeds"
	| "contains"
	| "returns"
	| "accepts"
	| "throws"
	| "reads"
	| "writes"
	| "tests"
	| "configures"
	| "wraps"
	| "depends_on"
	| "exposes"
	| "unknown";

export interface MemoryManifest {
	version: 1;
	projectPath: string;
	createdAt: string;
	updatedAt: string;
	counts: {
		files: number;
		symbols: number;
		relations: number;
		dirtyFiles: number;
	};
}

export interface FileEntry {
	filePath: string;
	kind: MemoryFileKind;
	language: string | null;
	hash: string | null;
	sizeBytes: number | null;
	indexedAt: string | null;
	indexStatus: MemoryIndexStatus;
	summary: string | null;
	updatedAt: string;
}

export interface SymbolAnchors {
	searchText: string;
	normalizedSignature: string;
	containerName?: string;
}

export interface SymbolEvidence {
	fileHash: string | null;
	searchTextHash: string;
	verifiedAt: string | null;
	verificationStatus: SymbolVerificationStatus;
}

export interface SymbolEntry {
	id: string;
	language: string;
	kind: string;
	name: string;
	qualifiedName: string | null;
	filePath: string;
	signature: string;
	summary: string;
	visibility: SymbolVisibility;
	stability: SymbolStability;
	anchors: SymbolAnchors;
	evidence: SymbolEvidence;
	confidence: number;
	updatedAt: string;
}

export interface SymbolRelation {
	id: string;
	fromSymbolId: string;
	toSymbolId: string | null;
	kind: SymbolRelationKind;
	summary: string;
	evidenceFilePath: string;
	evidenceSearchText: string;
	confidence: number;
	updatedAt: string;
}

export interface DeletedMemoryEntry {
	id: string;
	deletedAt: string;
	reason: string;
	previous: unknown;
}

export interface DirtyFileEntry {
	filePath: string;
	reason: string;
	markedAt: string;
}

export interface DirtyMemoryState {
	files: Record<string, DirtyFileEntry>;
}

export interface MemoryIndexes {
	byFile: Record<string, string[]>;
	byName: Record<string, string[]>;
	byKind: Record<string, string[]>;
	symbolShards: Record<string, string>;
	relationShards: Record<string, string>;
}

export const EMPTY_MEMORY_INDEXES: MemoryIndexes = {
	byFile: {},
	byName: {},
	byKind: {},
	symbolShards: {},
	relationShards: {},
};

export const EMPTY_DIRTY_MEMORY_STATE: DirtyMemoryState = {
	files: {},
};
