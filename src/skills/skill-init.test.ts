import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryFs } from "../test/memory-fs";
import { ensureSkillFile, readSkillMarkdown } from "./skill-init";

const AGENT_DIR = "/home/user/.pi/agent";
const SKILL_DIR = join(AGENT_DIR, "skills", "pi-planner");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");

describe("readSkillMarkdown", () => {
	it("reads the skill markdown file from the package", () => {
		const result = readSkillMarkdown();
		expect(result).toContain("# pi-planner");
		expect(result).toContain("pi-planner");
	});
});

describe("ensureSkillFile", () => {
	it("creates the skill file when it does not exist", () => {
		const fs = new MemoryFs();
		const customContent =
			'---\nname: pi-planner\ndescription: "custom"\n---\n\n# Custom\n\nContent.';

		ensureSkillFile(AGENT_DIR, fs, customContent);

		expect(fs.exists(SKILL_PATH)).toBe(true);
		expect(fs.readFile(SKILL_PATH)).toBe(customContent);
	});

	it("does not overwrite existing skill file", () => {
		const fs = new MemoryFs();
		const originalContent = "# Original";
		const newContent = "# New";

		fs.setFile(SKILL_PATH, originalContent);

		ensureSkillFile(AGENT_DIR, fs, newContent);

		expect(fs.readFile(SKILL_PATH)).toBe(originalContent);
	});

	it("creates parent directories", () => {
		const fs = new MemoryFs();

		ensureSkillFile(AGENT_DIR, fs, "# Content");

		expect(fs.exists(SKILL_DIR)).toBe(true);
		expect(fs.exists(SKILL_PATH)).toBe(true);
	});
});
