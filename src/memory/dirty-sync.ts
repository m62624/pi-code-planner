import type { RepoState } from "../git/state";
import type { PlannerRuntimeState } from "../planner-state/schema";
import type { MemorySettings } from "../settings/schema";
import type { DirtyMemoryState } from "./schema";
import type { ProjectMemoryStore } from "./store";

export interface SyncDirtyMemoryFromRepoInput {
	plannerState: PlannerRuntimeState;
	memory: ProjectMemoryStore;
	repo: RepoState;
	settings: Pick<
		MemorySettings,
		"autoDirtyTracking" | "dirtyPathIgnorePrefixes"
	>;
	reason?: string;
}

export interface SyncDirtyMemoryFromRepoResult {
	synced: boolean;
	changedFiles: string[];
	dirty: DirtyMemoryState;
}

function isPlannerActive(state: PlannerRuntimeState): boolean {
	return (
		state.mode === "plan_active" ||
		state.mode === "operation_in_progress" ||
		state.mode === "recovery_required" ||
		state.activePlanId !== null
	);
}

function normalizeRelativePath(filePath: string): string | null {
	const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (normalized.length === 0) return null;
	if (normalized.startsWith("/")) return null;
	return normalized;
}

function shouldIgnorePath(
	filePath: string,
	ignoredPrefixes: string[],
): boolean {
	return ignoredPrefixes
		.map((prefix) => normalizeRelativePath(prefix))
		.filter((prefix): prefix is string => prefix !== null)
		.some((prefix) => filePath === prefix || filePath.startsWith(prefix));
}

function collectChangedFiles(
	repo: RepoState,
	ignoredPrefixes: string[],
): string[] {
	const candidates = [
		...repo.status.stagedFiles,
		...repo.status.unstagedFiles,
		...repo.status.untrackedFiles,
		...repo.status.conflictedFiles,
		...repo.status.renamedFiles,
	];
	const unique = new Set<string>();
	for (const candidate of candidates) {
		const normalized = normalizeRelativePath(candidate);
		if (!normalized) continue;
		if (shouldIgnorePath(normalized, ignoredPrefixes)) continue;
		unique.add(normalized);
	}
	return [...unique].sort();
}

export function syncDirtyMemoryFromRepo(
	input: SyncDirtyMemoryFromRepoInput,
): SyncDirtyMemoryFromRepoResult {
	if (
		!input.settings.autoDirtyTracking ||
		!isPlannerActive(input.plannerState) ||
		!input.repo.isRepo
	) {
		return {
			synced: false,
			changedFiles: [],
			dirty: input.memory.getDirtyFiles(),
		};
	}

	const changedFiles = collectChangedFiles(
		input.repo,
		input.settings.dirtyPathIgnorePrefixes,
	);
	if (changedFiles.length === 0) {
		return {
			synced: false,
			changedFiles,
			dirty: input.memory.getDirtyFiles(),
		};
	}

	const dirty = input.memory.markFilesDirty(
		changedFiles,
		input.reason ?? "git status changed",
	);
	return { synced: true, changedFiles, dirty };
}
