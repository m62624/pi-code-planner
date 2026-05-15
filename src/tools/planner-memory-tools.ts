import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import type { ProjectMemoryStore } from "../memory/store";

export type ProjectMemoryStoreResolver = (cwd: string) => ProjectMemoryStore;

function ok<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function tool<TParams extends TSchema, TDetails>(
	definition: Omit<
		ToolDefinition<TParams, TDetails>,
		"executionMode" | "renderShell"
	> & { parameters: TParams },
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		executionMode: "sequential",
		renderShell: "default",
	};
}

const fileEntrySchema = Type.Object({
	filePath: Type.String(),
	kind: Type.Union([
		Type.Literal("source"),
		Type.Literal("test"),
		Type.Literal("config"),
		Type.Literal("docs"),
		Type.Literal("generated"),
		Type.Literal("vendor"),
		Type.Literal("unknown"),
	]),
	language: Type.Union([Type.String(), Type.Null()]),
	hash: Type.Union([Type.String(), Type.Null()]),
	sizeBytes: Type.Union([Type.Number(), Type.Null()]),
	indexedAt: Type.Union([Type.String(), Type.Null()]),
	indexStatus: Type.Union([
		Type.Literal("pending"),
		Type.Literal("indexed"),
		Type.Literal("dirty"),
		Type.Literal("ignored"),
		Type.Literal("failed"),
	]),
	summary: Type.Union([Type.String(), Type.Null()]),
	updatedAt: Type.Optional(Type.String()),
});

const symbolEntrySchema = Type.Object({
	id: Type.Optional(Type.String()),
	language: Type.String(),
	kind: Type.String(),
	name: Type.String(),
	qualifiedName: Type.Union([Type.String(), Type.Null()]),
	filePath: Type.String(),
	signature: Type.String(),
	summary: Type.String(),
	visibility: Type.Union([
		Type.Literal("public"),
		Type.Literal("package"),
		Type.Literal("crate"),
		Type.Literal("private"),
		Type.Literal("test_only"),
		Type.Literal("unknown"),
	]),
	stability: Type.Union([
		Type.Literal("stable"),
		Type.Literal("internal"),
		Type.Literal("generated"),
		Type.Literal("deprecated"),
		Type.Literal("unknown"),
	]),
	anchors: Type.Object({
		searchText: Type.String(),
		normalizedSignature: Type.Optional(Type.String()),
		containerName: Type.Optional(Type.String()),
	}),
	evidence: Type.Optional(
		Type.Object({
			fileHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			searchTextHash: Type.Optional(Type.String()),
			verifiedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			verificationStatus: Type.Optional(
				Type.Union([
					Type.Literal("verified"),
					Type.Literal("stale"),
					Type.Literal("missing"),
					Type.Literal("unverified"),
				]),
			),
		}),
	),
	confidence: Type.Number(),
	updatedAt: Type.Optional(Type.String()),
});

const relationEntrySchema = Type.Object({
	id: Type.Optional(Type.String()),
	fromSymbolId: Type.String(),
	toSymbolId: Type.Union([Type.String(), Type.Null()]),
	kind: Type.Union([
		Type.Literal("calls"),
		Type.Literal("implements"),
		Type.Literal("extends"),
		Type.Literal("embeds"),
		Type.Literal("contains"),
		Type.Literal("returns"),
		Type.Literal("accepts"),
		Type.Literal("throws"),
		Type.Literal("reads"),
		Type.Literal("writes"),
		Type.Literal("tests"),
		Type.Literal("configures"),
		Type.Literal("wraps"),
		Type.Literal("depends_on"),
		Type.Literal("exposes"),
		Type.Literal("unknown"),
	]),
	summary: Type.String(),
	evidenceFilePath: Type.String(),
	evidenceSearchText: Type.String(),
	confidence: Type.Number(),
	updatedAt: Type.Optional(Type.String()),
});

const emptySchema = Type.Object({});
const upsertFilesSchema = Type.Object({
	entries: Type.Array(fileEntrySchema),
});
const upsertSymbolsSchema = Type.Object({
	entries: Type.Array(symbolEntrySchema),
});
const upsertRelationsSchema = Type.Object({
	entries: Type.Array(relationEntrySchema),
});
const searchSymbolsSchema = Type.Object({
	name: Type.Optional(Type.String()),
	kind: Type.Optional(Type.String()),
	filePath: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});
const filePathSchema = Type.Object({
	filePath: Type.String(),
});
const symbolIdSchema = Type.Object({
	symbolId: Type.String(),
});
const deleteSymbolSchema = Type.Object({
	symbolId: Type.String(),
	reason: Type.String(),
});
const deleteRelationSchema = Type.Object({
	relationId: Type.String(),
	reason: Type.String(),
});
const markDirtySchema = Type.Object({
	filePaths: Type.Array(Type.String()),
	reason: Type.String(),
});
const clearDirtySchema = Type.Object({
	filePaths: Type.Array(Type.String()),
});

type UpsertFilesParams = Static<typeof upsertFilesSchema>;
type UpsertSymbolsParams = Static<typeof upsertSymbolsSchema>;
type UpsertRelationsParams = Static<typeof upsertRelationsSchema>;
type SearchSymbolsParams = Static<typeof searchSymbolsSchema>;
type FilePathParams = Static<typeof filePathSchema>;
type SymbolIdParams = Static<typeof symbolIdSchema>;
type DeleteSymbolParams = Static<typeof deleteSymbolSchema>;
type DeleteRelationParams = Static<typeof deleteRelationSchema>;
type MarkDirtyParams = Static<typeof markDirtySchema>;
type ClearDirtyParams = Static<typeof clearDirtySchema>;

function normalizeSymbolParams(params: UpsertSymbolsParams) {
	return params.entries.map((entry) => ({
		...entry,
		id: entry.id ?? "",
		anchors: {
			searchText: entry.anchors.searchText,
			normalizedSignature: entry.anchors.normalizedSignature ?? "",
			containerName: entry.anchors.containerName,
		},
		evidence: {
			fileHash: entry.evidence?.fileHash ?? null,
			searchTextHash: entry.evidence?.searchTextHash ?? "",
			verifiedAt: entry.evidence?.verifiedAt ?? null,
			verificationStatus: entry.evidence?.verificationStatus ?? "unverified",
		},
		updatedAt: entry.updatedAt ?? "",
	}));
}

function normalizeRelationParams(params: UpsertRelationsParams) {
	return params.entries.map((entry) => ({
		...entry,
		id: entry.id ?? "",
		updatedAt: entry.updatedAt ?? "",
	}));
}

const MEMORY_PROMPT_GUIDELINES = [
	"Use planner_memory_upsert_files and planner_memory_upsert_symbols during discovery instead of editing memory files directly.",
	"Use planner_memory_search_symbols and planner_memory_get_symbol_context to retrieve compact project context before reading broad code again.",
	"Use planner_memory_mark_dirty after known file changes when automatic dirty tracking is unavailable.",
	"Verify or delete stale memory entries instead of trusting hallucinated API records.",
];

export function createPlannerMemoryTools(
	getStore: ProjectMemoryStoreResolver,
): ToolDefinition[] {
	return [
		tool({
			name: "planner_memory_status",
			label: "planner memory status",
			description: "Inspect project memory manifest and dirty-file state.",
			promptSnippet:
				"CALL to inspect project memory counts and dirty files before discovery, commit, or compact.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: emptySchema,
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const store = getStore(ctx.cwd);
				const manifest = store.initialize();
				return ok("Planner memory status loaded.", {
					manifest,
					dirty: store.getDirtyFiles(),
				});
			},
		}),
		tool({
			name: "planner_memory_upsert_files",
			label: "planner memory upsert files",
			description: "Create or update project memory file inventory entries.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: upsertFilesSchema,
			execute: async (
				_id,
				params: UpsertFilesParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const files = getStore(ctx.cwd).upsertFiles(
					params.entries.map((entry) => ({
						...entry,
						updatedAt: entry.updatedAt ?? "",
					})),
				);
				return ok("Planner memory file inventory updated.", { files });
			},
		}),
		tool({
			name: "planner_memory_upsert_symbols",
			label: "planner memory upsert symbols",
			description: "Create or update language-neutral symbol/API entries.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: upsertSymbolsSchema,
			execute: async (
				_id,
				params: UpsertSymbolsParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const symbols = getStore(ctx.cwd).upsertSymbols(
					normalizeSymbolParams(params),
				);
				return ok("Planner memory symbols updated.", { symbols });
			},
		}),
		tool({
			name: "planner_memory_upsert_relations",
			label: "planner memory upsert relations",
			description: "Create or update symbol graph relation entries.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: upsertRelationsSchema,
			execute: async (
				_id,
				params: UpsertRelationsParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const relations = getStore(ctx.cwd).upsertRelations(
					normalizeRelationParams(params),
				);
				return ok("Planner memory relations updated.", { relations });
			},
		}),
		tool({
			name: "planner_memory_search_symbols",
			label: "planner memory search symbols",
			description: "Search indexed symbols by name, kind, file path, or text.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: searchSymbolsSchema,
			execute: async (
				_id,
				params: SearchSymbolsParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const symbols = getStore(ctx.cwd).searchSymbols(params);
				return ok("Planner memory symbol search completed.", { symbols });
			},
		}),
		tool({
			name: "planner_memory_get_symbols_by_file",
			label: "planner memory file symbols",
			description: "Read indexed symbols for one project file.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: filePathSchema,
			execute: async (_id, params: FilePathParams, _signal, _onUpdate, ctx) => {
				const symbols = getStore(ctx.cwd).getSymbolsByFile(params.filePath);
				return ok("Planner memory file symbols loaded.", { symbols });
			},
		}),
		tool({
			name: "planner_memory_get_symbol_context",
			label: "planner memory symbol context",
			description: "Read one symbol plus direct relation graph context.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: symbolIdSchema,
			execute: async (_id, params: SymbolIdParams, _signal, _onUpdate, ctx) => {
				const context = getStore(ctx.cwd).getSymbolContext(params.symbolId);
				return ok("Planner memory symbol context loaded.", { context });
			},
		}),
		tool({
			name: "planner_memory_get_relations",
			label: "planner memory relations",
			description: "Read relations connected to one symbol id.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: symbolIdSchema,
			execute: async (_id, params: SymbolIdParams, _signal, _onUpdate, ctx) => {
				const relations = getStore(ctx.cwd).getRelations(params.symbolId);
				return ok("Planner memory relations loaded.", { relations });
			},
		}),
		tool({
			name: "planner_memory_delete_symbol",
			label: "planner memory delete symbol",
			description: "Delete a stale or hallucinated symbol entry by id.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: deleteSymbolSchema,
			execute: async (
				_id,
				params: DeleteSymbolParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const deleted = getStore(ctx.cwd).deleteSymbol(
					params.symbolId,
					params.reason,
				);
				return ok("Planner memory symbol deletion processed.", { deleted });
			},
		}),
		tool({
			name: "planner_memory_delete_relation",
			label: "planner memory delete relation",
			description: "Delete a stale or hallucinated relation entry by id.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: deleteRelationSchema,
			execute: async (
				_id,
				params: DeleteRelationParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const deleted = getStore(ctx.cwd).deleteRelation(
					params.relationId,
					params.reason,
				);
				return ok("Planner memory relation deletion processed.", { deleted });
			},
		}),
		tool({
			name: "planner_memory_mark_dirty",
			label: "planner memory mark dirty",
			description: "Mark changed files as needing memory refresh.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: markDirtySchema,
			execute: async (
				_id,
				params: MarkDirtyParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const dirty = getStore(ctx.cwd).markFilesDirty(
					params.filePaths,
					params.reason,
				);
				return ok("Planner memory dirty files marked.", { dirty });
			},
		}),
		tool({
			name: "planner_memory_get_dirty",
			label: "planner memory dirty",
			description: "Read files currently marked dirty in project memory.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: emptySchema,
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const dirty = getStore(ctx.cwd).getDirtyFiles();
				return ok("Planner memory dirty files loaded.", { dirty });
			},
		}),
		tool({
			name: "planner_memory_clear_dirty",
			label: "planner memory clear dirty",
			description:
				"Clear dirty flags after affected memory entries were refreshed.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: clearDirtySchema,
			execute: async (
				_id,
				params: ClearDirtyParams,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const dirty = getStore(ctx.cwd).clearDirtyFiles(params.filePaths);
				return ok("Planner memory dirty files cleared.", { dirty });
			},
		}),
		tool({
			name: "planner_memory_verify_symbol",
			label: "planner memory verify symbol",
			description: "Verify one symbol by searching its current project file.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: symbolIdSchema,
			execute: async (_id, params: SymbolIdParams, _signal, _onUpdate, ctx) => {
				const result = getStore(ctx.cwd).verifySymbol(params.symbolId);
				return ok("Planner memory symbol verification completed.", { result });
			},
		}),
		tool({
			name: "planner_memory_verify_file",
			label: "planner memory verify file",
			description: "Verify all symbols indexed for one project file.",
			promptGuidelines: MEMORY_PROMPT_GUIDELINES,
			parameters: filePathSchema,
			execute: async (_id, params: FilePathParams, _signal, _onUpdate, ctx) => {
				const results = getStore(ctx.cwd).verifyFile(params.filePath);
				return ok("Planner memory file verification completed.", { results });
			},
		}),
	];
}
