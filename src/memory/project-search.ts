import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";

export const DEFAULT_PROJECT_SEARCH_LIMIT = 8;
export const MAX_PROJECT_SEARCH_LIMIT = 30;
const EXCERPT_CONTEXT_LINES = 2;
const MAX_SEARCH_FILE_CHARACTERS = 2_000_000;

export interface ProjectSearchMatch {
	path: string;
	score: number;
	startLine: number;
	endLine: number;
	excerpt: string;
}

export interface ProjectSearchResult {
	query: string;
	scannedFiles: number;
	skippedFiles: string[];
	matches: ProjectSearchMatch[];
}

export async function searchProjectFiles(input: {
	fs: PlannerFs;
	git: Pick<GitRunner, "listProjectFiles">;
	repoRoot: string;
	query: string;
	limit?: number;
}): Promise<ProjectSearchResult> {
	const query = input.query.trim();
	if (!query) throw new TypeError("query must be a non-empty string.");
	const tokens = tokenize(query);
	const files = uniqueSorted(await input.git.listProjectFiles(input));
	const skippedFiles: string[] = [];
	const matches: ProjectSearchMatch[] = [];

	for (const path of files) {
		if (!isSafeRelativePath(path)) {
			skippedFiles.push(path);
			continue;
		}
		try {
			const content = await input.fs.readText(join(input.repoRoot, path));
			if (
				content.includes("\0") ||
				content.length > MAX_SEARCH_FILE_CHARACTERS
			) {
				skippedFiles.push(path);
				continue;
			}
			const match = scoreFile(path, content, tokens);
			if (match) matches.push(match);
		} catch {
			skippedFiles.push(path);
		}
	}

	matches.sort(
		(left, right) =>
			right.score - left.score || left.path.localeCompare(right.path),
	);
	return {
		query,
		scannedFiles: files.length,
		skippedFiles,
		matches: matches.slice(0, clampLimit(input.limit)),
	};
}

function isSafeRelativePath(path: string): boolean {
	return (
		path.trim().length > 0 &&
		!/^[/\\]|^[A-Za-z]:[\\/]/.test(path) &&
		!path.split(/[\\/]+/).includes("..")
	);
}

function scoreFile(
	path: string,
	content: string,
	tokens: readonly string[],
): ProjectSearchMatch | null {
	const lines = content.split(/\r?\n/);
	const normalizedPath = normalizeText(path);
	let score = 0;
	let bestLine = 0;
	let bestLineScore = 0;
	for (const token of tokens) {
		if (matchesToken(token, normalizedPath)) score += 8;
	}
	for (let index = 0; index < lines.length; index += 1) {
		const normalized = normalizeText(lines[index] ?? "");
		let lineScore = 0;
		for (const token of tokens) {
			if (matchesToken(token, normalized)) lineScore += 2;
		}
		if (lineScore > bestLineScore) {
			bestLine = index;
			bestLineScore = lineScore;
		}
		score += lineScore;
	}
	if (score === 0) return null;
	const start = Math.max(0, bestLine - EXCERPT_CONTEXT_LINES);
	const end = Math.min(lines.length, bestLine + EXCERPT_CONTEXT_LINES + 1);
	return {
		path,
		score,
		startLine: start + 1,
		endLine: end,
		excerpt: lines
			.slice(start, end)
			.map((line, index) => `${start + index + 1} | ${line}`)
			.join("\n"),
	};
}

function matchesToken(token: string, text: string): boolean {
	if (text.includes(token)) return true;
	return text
		.split(/\s+/)
		.some(
			(candidate) =>
				candidate.includes(token) ||
				token.includes(candidate) ||
				trigramSimilarity(token, candidate) >= 0.6,
		);
}

function trigramSimilarity(left: string, right: string): number {
	if (left.length < 3 || right.length < 3) return 0;
	const leftTrigrams = trigrams(left);
	const rightTrigrams = trigrams(right);
	let shared = 0;
	for (const value of leftTrigrams) {
		if (rightTrigrams.has(value)) shared += 1;
	}
	return shared / Math.max(leftTrigrams.size, rightTrigrams.size);
}

function trigrams(value: string): Set<string> {
	const result = new Set<string>();
	for (let index = 0; index + 3 <= value.length; index += 1) {
		result.add(value.slice(index, index + 3));
	}
	return result;
}

function tokenize(text: string): string[] {
	return [
		...new Set(
			normalizeText(text)
				.split(/\s+/)
				.filter((token) => token.length >= 2),
		),
	];
}

function normalizeText(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_./\\-]+/g, " ")
		.toLowerCase();
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit))
		return DEFAULT_PROJECT_SEARCH_LIMIT;
	return Math.min(MAX_PROJECT_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths.filter((path) => path.trim().length > 0))].sort();
}
