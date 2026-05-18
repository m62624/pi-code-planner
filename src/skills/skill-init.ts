import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SKILL_MARKDOWN_PATH = new URL(
	"../instructions/markdown/pi-planner.md",
	import.meta.url,
);

export interface SkillFs {
	exists(path: string): boolean;
	readFile(path: string): string;
	mkdirp(path: string): void;
	writeFile(path: string, content: string): void;
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function createNodeSkillFs(): SkillFs {
	return {
		exists(path) {
			return existsSync(path);
		},
		readFile(path) {
			return readFileSync(path, "utf-8");
		},
		mkdirp(path) {
			mkdirSync(path, { recursive: true });
		},
		writeFile(path, content) {
			const dir = dirname(path);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(path, content, "utf-8");
		},
	};
}

export function readSkillMarkdown(): string {
	return readFileSync(SKILL_MARKDOWN_PATH, "utf-8");
}

export function ensureSkillFile(
	agentDir: string,
	fs: SkillFs,
	content: string = readSkillMarkdown(),
): void {
	const skillDir = join(agentDir, "skills", "pi-planner");
	const skillPath = join(skillDir, "SKILL.md");

	if (fs.exists(skillPath)) {
		const existing = fs.readFile(skillPath);
		if (sha256(existing) === sha256(content)) return;
	}

	fs.mkdirp(skillDir);
	fs.writeFile(skillPath, content);
}
