import { describe, expect, it } from "vitest";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { DEFAULT_INSTRUCTIONS } from "./defaults";
import {
	getInstructionContent,
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

		const result = await syncInstructionFiles(fs, paths, DEFAULT_INSTRUCTIONS);

		expect(result).toHaveLength(INSTRUCTION_KEYS.length);
		expect(result.every((item) => item.defaultAction === "created")).toBe(true);
		expect(result.every((item) => item.globalAppendAction === "created")).toBe(
			true,
		);
		for (const key of INSTRUCTION_KEYS) {
			expect(fs.snapshot()[instructionFilePath(paths.defaultsDir, key)]).toBe(
				DEFAULT_INSTRUCTIONS[key],
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
		await syncInstructionFiles(fs, paths, DEFAULT_INSTRUCTIONS);
		await fs.writeTextAtomic(
			instructionFilePath(paths.globalAppendDir, "discovery"),
			"global notes\n",
		);
		const nextDefaults: InstructionDefaults = {
			...DEFAULT_INSTRUCTIONS,
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
		await syncInstructionFiles(fs, paths, DEFAULT_INSTRUCTIONS);

		const content = await getInstructionContent(fs, paths, "planning");

		expect(content).toMatchObject({
			key: "planning",
			appendSource: "global",
			appendPath: instructionFilePath(paths.globalAppendDir, "planning"),
			content: DEFAULT_INSTRUCTIONS.planning,
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
		await syncInstructionFiles(fs, paths, DEFAULT_INSTRUCTIONS);
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
		await syncInstructionFiles(fs, paths, DEFAULT_INSTRUCTIONS);
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
});
