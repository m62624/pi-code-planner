import { join } from "node:path";
import { EXTENSION_NAME } from "../constants";
import type { PlannerFs } from "../storage/fs";

export const PROJECT_WORKTREES_IGNORE_RULE = `.pi/${EXTENSION_NAME}/worktrees/`;

export interface GitignoreWorktreeRuleResult {
	path: string;
	rule: string;
	action: "created" | "appended" | "unchanged";
}

export async function ensureProjectWorktreesIgnored(
	fs: PlannerFs,
	projectRoot: string,
): Promise<GitignoreWorktreeRuleResult> {
	return await ensureWorktreesIgnoreRule(fs, join(projectRoot, ".gitignore"));
}

export async function ensureProjectWorktreesLocallyExcluded(
	fs: PlannerFs,
	projectRoot: string,
	excludePath = join(projectRoot, ".git", "info", "exclude"),
): Promise<GitignoreWorktreeRuleResult> {
	return await ensureWorktreesIgnoreRule(fs, excludePath);
}

async function ensureWorktreesIgnoreRule(
	fs: PlannerFs,
	path: string,
): Promise<GitignoreWorktreeRuleResult> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, `${PROJECT_WORKTREES_IGNORE_RULE}\n`);
		return { path, rule: PROJECT_WORKTREES_IGNORE_RULE, action: "created" };
	}

	const content = await fs.readText(path);
	if (hasExactWorktreesIgnoreRule(content)) {
		return { path, rule: PROJECT_WORKTREES_IGNORE_RULE, action: "unchanged" };
	}

	await fs.writeTextAtomic(
		path,
		appendGitignoreRule(content, PROJECT_WORKTREES_IGNORE_RULE),
	);
	return { path, rule: PROJECT_WORKTREES_IGNORE_RULE, action: "appended" };
}

export function hasExactWorktreesIgnoreRule(content: string): boolean {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.some(
			(line) => normalizeGitignoreRule(line) === PROJECT_WORKTREES_IGNORE_RULE,
		);
}

function normalizeGitignoreRule(line: string): string {
	if (line.startsWith("./")) {
		return line.slice(2);
	}
	return line;
}

function appendGitignoreRule(content: string, rule: string): string {
	const normalized =
		content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
	return `${normalized}${rule}\n`;
}
