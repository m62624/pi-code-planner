import { describe, expect, it } from "vitest";
import type { GitRepoInput, GitRunner } from "../git/runner";
import { buildProjectMap } from "./project-map";

class ProjectMapGitRunner implements Pick<GitRunner, "listProjectFiles"> {
	constructor(private readonly files: string[]) {}

	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return this.files;
	}
}

describe("mechanical project map", () => {
	it("summarizes structure without reading project file contents", async () => {
		const result = await buildProjectMap({
			git: new ProjectMapGitRunner([
				"Cargo.toml",
				"src/lib.rs",
				"src/parser.rs",
				"tests/parser.rs",
				".github/workflows/ci.yml",
				"README.md",
			]) as GitRunner,
			repoRoot: "/repo/app",
		});

		expect(result).toMatchObject({
			totalFiles: 6,
			topLevelAreas: [
				{ path: ".github", files: 1 },
				{ path: "(root)", files: 2 },
				{ path: "src", files: 2 },
				{ path: "tests", files: 1 },
			],
			extensions: [
				{ extension: ".md", files: 1 },
				{ extension: ".rs", files: 3 },
				{ extension: ".toml", files: 1 },
				{ extension: ".yml", files: 1 },
			],
			manifests: ["Cargo.toml"],
			entrypoints: ["src/lib.rs"],
			testPaths: ["tests/parser.rs"],
			configPaths: [".github/workflows/ci.yml", "Cargo.toml"],
		});
	});

	it("bounds path groups for large projects", async () => {
		const files = Array.from(
			{ length: 80 },
			(_, index) => `src/file-${index}.ts`,
		);
		const result = await buildProjectMap({
			git: new ProjectMapGitRunner(files) as GitRunner,
			repoRoot: "/repo/app",
			maxPathsPerGroup: 5,
		});

		expect(result.totalFiles).toBe(80);
		expect(result.samplePaths).toHaveLength(5);
		expect(result.truncated).toBe(true);
	});
});
