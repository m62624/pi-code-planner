import { describe, expect, it } from "vitest";
import { createNodeFs } from "../storage/fs";
import { createProjectStoragePaths } from "../storage/paths";
import { TEST_INSTRUCTION_DEFAULTS } from "../test/instruction-defaults";
import { MockPlannerFs } from "../test/mock-fs";
import {
	loadBundledInstructionDefaults,
	syncBundledInstructionFiles,
} from "./defaults";
import {
	getInstructionContent,
	getInstructionSection,
	getInstructionSectionContent,
	parseInstructionSections,
	readInstructionDefaultsFromDir,
	syncInstructionFiles,
} from "./manager";
import { createInstructionPaths, instructionFilePath } from "./paths";
import { INSTRUCTION_KEYS, type InstructionDefaults } from "./schema";

describe("instruction manager", () => {
	it("syncs every default instruction and creates global append placeholders", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);

		const result = await syncInstructionFiles(
			fs,
			paths,
			TEST_INSTRUCTION_DEFAULTS,
		);

		expect(result).toHaveLength(INSTRUCTION_KEYS.length);
		expect(result.every((item) => item.defaultAction === "created")).toBe(true);
		expect(result.every((item) => item.globalAppendAction === "created")).toBe(
			true,
		);
		for (const key of INSTRUCTION_KEYS) {
			expect(fs.snapshot()[instructionFilePath(paths.defaultsDir, key)]).toBe(
				TEST_INSTRUCTION_DEFAULTS[key],
			);
			expect(
				fs.snapshot()[instructionFilePath(paths.globalAppendDir, key)],
			).toBe("");
		}
	});

	it("updates changed defaults but never overwrites existing append files", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		await syncInstructionFiles(fs, paths, TEST_INSTRUCTION_DEFAULTS);
		await fs.writeTextAtomic(
			instructionFilePath(paths.globalAppendDir, "discovery"),
			"global notes\n",
		);
		const nextDefaults: InstructionDefaults = {
			...TEST_INSTRUCTION_DEFAULTS,
			discovery: "# discovery v2\n",
		};

		const result = await syncInstructionFiles(fs, paths, nextDefaults);

		expect(result.find((item) => item.key === "discovery")?.defaultAction).toBe(
			"updated",
		);
		expect(
			fs.snapshot()[instructionFilePath(paths.defaultsDir, "discovery")],
		).toBe("# discovery v2\n");
		expect(
			fs.snapshot()[instructionFilePath(paths.globalAppendDir, "discovery")],
		).toBe("global notes\n");
	});

	it("returns default only when selected append is empty", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		await syncInstructionFiles(fs, paths, TEST_INSTRUCTION_DEFAULTS);

		const content = await getInstructionContent(fs, paths, "planning");

		expect(content).toMatchObject({
			key: "planning",
			appendSource: "global",
			appendPath: instructionFilePath(paths.globalAppendDir, "planning"),
			content: TEST_INSTRUCTION_DEFAULTS.planning,
		});
	});

	it("uses global append when project append is missing", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		await syncInstructionFiles(fs, paths, TEST_INSTRUCTION_DEFAULTS);
		await fs.writeTextAtomic(
			instructionFilePath(paths.globalAppendDir, "tdd"),
			"Use cargo test.\n",
		);

		const content = await getInstructionContent(fs, paths, "tdd");

		expect(content.appendSource).toBe("global");
		expect(content.content).toBe("# tdd\n\nUse cargo test.\n");
	});

	it("uses project append instead of global append when both exist", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		await syncInstructionFiles(fs, paths, TEST_INSTRUCTION_DEFAULTS);
		await fs.writeTextAtomic(
			instructionFilePath(paths.globalAppendDir, "git-commit"),
			"Global style.\n",
		);
		await fs.writeTextAtomic(
			instructionFilePath(paths.projectAppendDir, "git-commit"),
			"Project style.\n",
		);

		const content = await getInstructionContent(fs, paths, "git-commit");

		expect(content.appendSource).toBe("project");
		expect(content.appendPath).toBe(
			instructionFilePath(paths.projectAppendDir, "git-commit"),
		);
		expect(content.content).toBe("# git-commit\n\nProject style.\n");
		expect(content.content).not.toContain("Global style");
	});

	it("can load default instructions from a markdown directory", async () => {
		const fs = new MockPlannerFs();
		for (const key of INSTRUCTION_KEYS) {
			await fs.writeTextAtomic(
				`/repo/instructions/defaults/${key}.md`,
				`# ${key} from md\n`,
			);
		}

		const defaults = await readInstructionDefaultsFromDir(
			fs,
			"/repo/instructions/defaults",
		);

		expect(defaults.discovery).toBe("# discovery from md\n");
		expect(defaults["git-commit"]).toBe("# git-commit from md\n");
	});

	it("loads bundled defaults through the markdown directory loader", async () => {
		const fs = new MockPlannerFs();
		for (const key of INSTRUCTION_KEYS) {
			await fs.writeTextAtomic(
				`/repo/instructions/defaults/${key}.md`,
				`# bundled ${key}\n`,
			);
		}

		const defaults = await loadBundledInstructionDefaults(
			fs,
			"/repo/instructions/defaults",
		);

		expect(defaults.discovery).toBe("# bundled discovery\n");
		expect(defaults.memory).toBe("# bundled memory\n");
	});

	it("loads repository markdown files as the bundled defaults", async () => {
		const defaults = await loadBundledInstructionDefaults(createNodeFs());

		expect(defaults.discovery).toContain("# discovery");
		expect(defaults.discovery).toContain("## Strict Step Order");
		expect(defaults.memory).toContain(
			"Memory is a selective durable knowledge base",
		);
	});

	it("keeps every repository default substantive and auto-compact aware", async () => {
		const defaults = await loadBundledInstructionDefaults(createNodeFs());

		for (const key of INSTRUCTION_KEYS) {
			expect(
				defaults[key].length,
				`${key}.md should be substantive`,
			).toBeGreaterThan(120);
			expect(
				getInstructionSection(defaults[key], "auto-compact"),
				`${key}.md should define auto-compact recovery`,
			).toMatchObject({ found: true });
		}
	});

	it("syncs installed defaults from bundled markdown without overwriting append", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		for (const key of INSTRUCTION_KEYS) {
			await fs.writeTextAtomic(
				`/repo/instructions/defaults/${key}.md`,
				`# bundled ${key}\n`,
			);
		}
		await fs.writeTextAtomic(
			instructionFilePath(paths.globalAppendDir, "discovery"),
			"Keep global notes.\n",
		);

		await syncBundledInstructionFiles(fs, paths, "/repo/instructions/defaults");

		expect(
			fs.snapshot()[instructionFilePath(paths.defaultsDir, "discovery")],
		).toBe("# bundled discovery\n");
		expect(
			fs.snapshot()[instructionFilePath(paths.globalAppendDir, "discovery")],
		).toBe("Keep global notes.\n");
	});

	it("parses only level-two instruction sections", () => {
		const sections = parseInstructionSections(
			[
				"# compact",
				"intro",
				"## Manual Compact",
				"manual body",
				"### nested",
				"nested body",
				"## auto compact",
				"auto body",
				"# another title",
				"still auto body",
			].join("\n"),
		);

		expect(sections.get("manual-compact")).toBe(
			"manual body\n### nested\nnested body",
		);
		expect(sections.get("auto-compact")).toBe(
			"auto body\n# another title\nstill auto body",
		);
		expect(sections.has("compact")).toBe(false);
	});

	it("returns a requested compact section from joined default and append content", async () => {
		const fs = new MockPlannerFs();
		const paths = createInstructionPaths(
			createProjectStoragePaths({
				agentDir: "/agent",
				projectRoot: "/repo/app",
			}),
		);
		await syncInstructionFiles(fs, paths, {
			...TEST_INSTRUCTION_DEFAULTS,
			execution: [
				"# execution",
				"",
				"## manual-compact",
				"Keep task id and artifact links.",
			].join("\n"),
		});
		await fs.writeTextAtomic(
			instructionFilePath(paths.projectAppendDir, "execution"),
			["## auto-compact", "Call planner_status before resuming."].join("\n"),
		);

		const manual = await getInstructionSectionContent(
			fs,
			paths,
			"execution",
			"manual-compact",
		);
		const auto = await getInstructionSectionContent(
			fs,
			paths,
			"execution",
			"auto-compact",
		);

		expect(manual.section).toEqual({
			name: "manual-compact",
			content: "Keep task id and artifact links.",
			found: true,
		});
		expect(auto.section).toEqual({
			name: "auto-compact",
			content: "Call planner_status before resuming.",
			found: true,
		});
		expect(auto.appendSource).toBe("project");
	});

	it("reports missing compact sections without failing", () => {
		const section = getInstructionSection(
			"# execution\n\nNo compact section.",
			"auto-compact",
		);

		expect(section).toEqual({
			name: "auto-compact",
			content: "",
			found: false,
		});
	});
});
