export type GitStatusKind =
	| "ordinary"
	| "renamed"
	| "copied"
	| "untracked"
	| "ignored"
	| "conflicted";

export interface GitStatusEntry {
	path: string;
	originalPath: string | null;
	indexStatus: string;
	worktreeStatus: string;
	kind: GitStatusKind;
}

export interface GitStatusSummary {
	entries: GitStatusEntry[];
	stagedFiles: string[];
	unstagedFiles: string[];
	untrackedFiles: string[];
	ignoredFiles: string[];
	conflictedFiles: string[];
	renamedFiles: string[];
	hasStagedChanges: boolean;
	hasUnstagedChanges: boolean;
	hasUntrackedFiles: boolean;
	hasIgnoredFiles: boolean;
	hasConflicts: boolean;
	isDirty: boolean;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function emptyGitStatusSummary(): GitStatusSummary {
	return {
		entries: [],
		stagedFiles: [],
		unstagedFiles: [],
		untrackedFiles: [],
		ignoredFiles: [],
		conflictedFiles: [],
		renamedFiles: [],
		hasStagedChanges: false,
		hasUnstagedChanges: false,
		hasUntrackedFiles: false,
		hasIgnoredFiles: false,
		hasConflicts: false,
		isDirty: false,
	};
}

function unquotePath(path: string): string {
	const trimmed = path.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return trimmed;
}

function parseRenamePath(rawPath: string): {
	path: string;
	originalPath: string | null;
} {
	const marker = " -> ";
	const idx = rawPath.indexOf(marker);
	if (idx === -1) {
		return { path: unquotePath(rawPath), originalPath: null };
	}

	return {
		originalPath: unquotePath(rawPath.slice(0, idx)),
		path: unquotePath(rawPath.slice(idx + marker.length)),
	};
}

function classifyEntry(
	indexStatus: string,
	worktreeStatus: string,
): GitStatusKind {
	const code = `${indexStatus}${worktreeStatus}`;
	if (code === "??") return "untracked";
	if (code === "!!") return "ignored";
	if (CONFLICT_CODES.has(code)) return "conflicted";
	if (indexStatus === "R") return "renamed";
	if (indexStatus === "C") return "copied";
	return "ordinary";
}

export function parsePorcelainStatus(output: string): GitStatusSummary {
	const summary = emptyGitStatusSummary();
	const lines = output.split(/\r?\n/).filter((line) => line.length > 0);

	for (const line of lines) {
		const indexStatus = line[0] ?? " ";
		const worktreeStatus = line[1] ?? " ";
		const rawPath = line.slice(3);
		const kind = classifyEntry(indexStatus, worktreeStatus);
		const parsedPath =
			kind === "renamed" || kind === "copied"
				? parseRenamePath(rawPath)
				: { path: unquotePath(rawPath), originalPath: null };
		const entry: GitStatusEntry = {
			path: parsedPath.path,
			originalPath: parsedPath.originalPath,
			indexStatus,
			worktreeStatus,
			kind,
		};

		summary.entries.push(entry);

		if (kind === "untracked") {
			summary.untrackedFiles.push(entry.path);
			continue;
		}

		if (kind === "ignored") {
			summary.ignoredFiles.push(entry.path);
			continue;
		}

		if (kind === "conflicted") {
			summary.conflictedFiles.push(entry.path);
			continue;
		}

		if (kind === "renamed") {
			summary.renamedFiles.push(entry.path);
		}

		if (indexStatus !== " ") {
			summary.stagedFiles.push(entry.path);
		}

		if (worktreeStatus !== " ") {
			summary.unstagedFiles.push(entry.path);
		}
	}

	summary.hasStagedChanges = summary.stagedFiles.length > 0;
	summary.hasUnstagedChanges = summary.unstagedFiles.length > 0;
	summary.hasUntrackedFiles = summary.untrackedFiles.length > 0;
	summary.hasIgnoredFiles = summary.ignoredFiles.length > 0;
	summary.hasConflicts = summary.conflictedFiles.length > 0;
	summary.isDirty =
		summary.hasStagedChanges ||
		summary.hasUnstagedChanges ||
		summary.hasUntrackedFiles ||
		summary.hasConflicts;

	return summary;
}
