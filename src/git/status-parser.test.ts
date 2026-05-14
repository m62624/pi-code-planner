import { describe, expect, it } from "vitest";
import { parsePorcelainStatus } from "./status-parser";

describe("parsePorcelainStatus", () => {
	it("parses clean output", () => {
		const status = parsePorcelainStatus("");

		expect(status.entries).toEqual([]);
		expect(status.isDirty).toBe(false);
	});

	it("parses unstaged modified files", () => {
		const status = parsePorcelainStatus(" M src/a.ts\n");

		expect(status.unstagedFiles).toEqual(["src/a.ts"]);
		expect(status.hasUnstagedChanges).toBe(true);
		expect(status.isDirty).toBe(true);
	});

	it("parses staged modified files", () => {
		const status = parsePorcelainStatus("M  src/a.ts\n");

		expect(status.stagedFiles).toEqual(["src/a.ts"]);
		expect(status.hasStagedChanges).toBe(true);
	});

	it("parses staged adds with unstaged edits", () => {
		const status = parsePorcelainStatus("AM src/a.ts\n");

		expect(status.stagedFiles).toEqual(["src/a.ts"]);
		expect(status.unstagedFiles).toEqual(["src/a.ts"]);
		expect(status.isDirty).toBe(true);
	});

	it("parses files with both staged and unstaged changes", () => {
		const status = parsePorcelainStatus("MM src/a.ts\n");

		expect(status.stagedFiles).toEqual(["src/a.ts"]);
		expect(status.unstagedFiles).toEqual(["src/a.ts"]);
	});

	it("parses untracked files", () => {
		const status = parsePorcelainStatus("?? src/new.ts\n");

		expect(status.untrackedFiles).toEqual(["src/new.ts"]);
		expect(status.hasUntrackedFiles).toBe(true);
		expect(status.isDirty).toBe(true);
	});

	it("parses staged deletes", () => {
		const status = parsePorcelainStatus("D  src/deleted.ts\n");

		expect(status.stagedFiles).toEqual(["src/deleted.ts"]);
		expect(status.unstagedFiles).toEqual([]);
	});

	it("parses unstaged deletes", () => {
		const status = parsePorcelainStatus(" D src/deleted.ts\n");

		expect(status.stagedFiles).toEqual([]);
		expect(status.unstagedFiles).toEqual(["src/deleted.ts"]);
	});

	it("parses ignored files without marking the repo dirty", () => {
		const status = parsePorcelainStatus("!! dist/index.js\n");

		expect(status.ignoredFiles).toEqual(["dist/index.js"]);
		expect(status.hasIgnoredFiles).toBe(true);
		expect(status.isDirty).toBe(false);
	});

	it("parses renamed files", () => {
		const status = parsePorcelainStatus("R  src/old.ts -> src/new.ts\n");

		expect(status.renamedFiles).toEqual(["src/new.ts"]);
		expect(status.stagedFiles).toEqual(["src/new.ts"]);
		expect(status.entries[0]).toMatchObject({
			kind: "renamed",
			originalPath: "src/old.ts",
			path: "src/new.ts",
		});
	});

	it("parses copied files", () => {
		const status = parsePorcelainStatus("C  src/a.ts -> src/b.ts\n");

		expect(status.stagedFiles).toEqual(["src/b.ts"]);
		expect(status.entries[0]).toMatchObject({
			kind: "copied",
			originalPath: "src/a.ts",
			path: "src/b.ts",
		});
	});

	it("parses conflict states", () => {
		const status = parsePorcelainStatus("UU src/conflict.ts\nAA src/new.ts\n");

		expect(status.conflictedFiles).toEqual(["src/conflict.ts", "src/new.ts"]);
		expect(status.hasConflicts).toBe(true);
		expect(status.isDirty).toBe(true);
	});

	it("parses every porcelain conflict code", () => {
		const status = parsePorcelainStatus(
			[
				"DD src/dd.ts",
				"AU src/au.ts",
				"UD src/ud.ts",
				"UA src/ua.ts",
				"DU src/du.ts",
				"AA src/aa.ts",
				"UU src/uu.ts",
			].join("\n"),
		);

		expect(status.conflictedFiles).toEqual([
			"src/dd.ts",
			"src/au.ts",
			"src/ud.ts",
			"src/ua.ts",
			"src/du.ts",
			"src/aa.ts",
			"src/uu.ts",
		]);
		expect(status.stagedFiles).toEqual([]);
		expect(status.unstagedFiles).toEqual([]);
	});

	it("parses quoted paths", () => {
		const status = parsePorcelainStatus(' M "src/a file.ts"\n');

		expect(status.unstagedFiles).toEqual(["src/a file.ts"]);
	});

	it("parses quoted renamed paths", () => {
		const status = parsePorcelainStatus(
			'R  "src/old file.ts" -> "src/new file.ts"\n',
		);

		expect(status.entries[0]).toMatchObject({
			kind: "renamed",
			originalPath: "src/old file.ts",
			path: "src/new file.ts",
		});
		expect(status.renamedFiles).toEqual(["src/new file.ts"]);
	});
});
