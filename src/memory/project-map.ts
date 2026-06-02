import { extname } from "node:path";
import type { GitRunner } from "../git/runner";

export const DEFAULT_PROJECT_MAP_PATH_LIMIT = 30;
export const MAX_PROJECT_MAP_PATH_LIMIT = 100;

export interface ProjectMapCount {
	path: string;
	files: number;
}

export interface ProjectMapExtensionCount {
	extension: string;
	files: number;
}

export interface ProjectMapResult {
	totalFiles: number;
	topLevelAreas: ProjectMapCount[];
	extensions: ProjectMapExtensionCount[];
	manifests: string[];
	entrypoints: string[];
	testPaths: string[];
	configPaths: string[];
	samplePaths: string[];
	truncated: boolean;
}

const MANIFEST_NAMES = new Set([
	"cargo.toml",
	"composer.json",
	"deno.json",
	"deno.jsonc",
	"go.mod",
	"package.json",
	"pom.xml",
	"pyproject.toml",
	"requirements.txt",
	"setup.py",
	"build.gradle",
	"build.gradle.kts",
]);

const ENTRYPOINT_NAMES = new Set([
	"app.ts",
	"app.tsx",
	"index.js",
	"index.ts",
	"index.tsx",
	"lib.rs",
	"main.go",
	"main.js",
	"main.py",
	"main.rs",
	"main.ts",
	"mod.rs",
]);

export async function buildProjectMap(input: {
	git: Pick<GitRunner, "listProjectFiles">;
	repoRoot: string;
	maxPathsPerGroup?: number;
}): Promise<ProjectMapResult> {
	const files = uniqueSorted(await input.git.listProjectFiles(input));
	const limit = clampLimit(input.maxPathsPerGroup);
	const topLevel = new Map<string, number>();
	const extensions = new Map<string, number>();

	for (const path of files) {
		const parts = path.split("/");
		const area = parts.length > 1 ? (parts[0] ?? "(root)") : "(root)";
		topLevel.set(area, (topLevel.get(area) ?? 0) + 1);
		const extension = extname(path).toLowerCase() || "(none)";
		extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
	}

	const manifests = files.filter(isManifest);
	const entrypoints = files.filter(isEntrypoint);
	const testPaths = files.filter(isTestPath);
	const configPaths = files.filter(isConfigPath);
	return {
		totalFiles: files.length,
		topLevelAreas: [...topLevel]
			.map(([path, count]) => ({ path, files: count }))
			.sort((left, right) => left.path.localeCompare(right.path)),
		extensions: [...extensions]
			.map(([extension, count]) => ({ extension, files: count }))
			.sort((left, right) => left.extension.localeCompare(right.extension)),
		manifests: manifests.slice(0, limit),
		entrypoints: entrypoints.slice(0, limit),
		testPaths: testPaths.slice(0, limit),
		configPaths: configPaths.slice(0, limit),
		samplePaths: files.slice(0, limit),
		truncated:
			files.length > limit ||
			manifests.length > limit ||
			entrypoints.length > limit ||
			testPaths.length > limit ||
			configPaths.length > limit,
	};
}

function isManifest(path: string): boolean {
	return MANIFEST_NAMES.has(basename(path).toLowerCase());
}

function isEntrypoint(path: string): boolean {
	return ENTRYPOINT_NAMES.has(basename(path).toLowerCase());
}

function isTestPath(path: string): boolean {
	return /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(
		path,
	);
}

function isConfigPath(path: string): boolean {
	const name = basename(path).toLowerCase();
	return (
		isManifest(path) ||
		path.startsWith(".github/") ||
		/(^|[._-])(config|settings|rc)([._-]|$)/i.test(name) ||
		name.startsWith(".")
	);
}

function basename(path: string): string {
	return path.split("/").at(-1) ?? path;
}

function clampLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return DEFAULT_PROJECT_MAP_PATH_LIMIT;
	}
	return Math.min(MAX_PROJECT_MAP_PATH_LIMIT, Math.max(1, Math.trunc(value)));
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths.filter((path) => path.trim().length > 0))].sort();
}
