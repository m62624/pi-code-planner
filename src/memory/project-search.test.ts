import { describe, expect, it } from "vitest";
import type { GitRepoInput, GitRunner } from "../git/runner";
import { MockPlannerFs } from "../test/mock-fs";
import { searchProjectFiles } from "./project-search";

class SearchGitRunner implements Pick<GitRunner, "listProjectFiles"> {
	constructor(private readonly files: string[]) {}

	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return this.files;
	}
}

describe("selective project search", () => {
	it("returns bounded relevant excerpts without persisting a whole-project index", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText(
			"/repo/app/src/config.ts",
			"export function parseConfig(input: string) {\n\treturn input;\n}\n",
		);
		await fs.writeText(
			"/repo/app/src/server.ts",
			"export function startServer() {\n\treturn listen();\n}\n",
		);

		const result = await searchProjectFiles({
			fs,
			git: new SearchGitRunner(["src/config.ts", "src/server.ts"]) as GitRunner,
			repoRoot: "/repo/app",
			query: "configuration parser",
			limit: 1,
		});

		expect(result.scannedFiles).toBe(2);
		expect(result.matches).toMatchObject([
			{
				path: "src/config.ts",
				startLine: 1,
				endLine: 4,
			},
		]);
		expect(result.matches[0]?.excerpt).toContain("parseConfig");
		expect(fs.snapshot()).toEqual({
			"/repo/app/src/config.ts":
				"export function parseConfig(input: string) {\n\treturn input;\n}\n",
			"/repo/app/src/server.ts":
				"export function startServer() {\n\treturn listen();\n}\n",
		});
	});

	it("skips unsafe paths instead of reading outside the worktree", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText("/outside.ts", "export const secret = true;\n");

		const result = await searchProjectFiles({
			fs,
			git: new SearchGitRunner(["../outside.ts"]) as GitRunner,
			repoRoot: "/repo/app",
			query: "secret",
		});

		expect(result.matches).toEqual([]);
		expect(result.skippedFiles).toEqual(["../outside.ts"]);
	});
});
