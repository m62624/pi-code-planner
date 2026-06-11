import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";
import type { ProjectStoragePaths } from "../storage/paths";

export const PLANNER_SKILL_TOOL_NAMES = ["planner_skill_create"] as const;

export type PlannerSkillToolName = (typeof PLANNER_SKILL_TOOL_NAMES)[number];

export const PLANNER_SKILL_SOURCE_KINDS = [
	"stuck",
	"debug",
	"doubt_review",
	"refactor",
	"guard_recovery",
	"final_summary",
	"other",
] as const;

export type PlannerSkillSourceKind =
	(typeof PLANNER_SKILL_SOURCE_KINDS)[number];

export interface PlannerSkillIndex {
	version: 1;
	items: PlannerSkillIndexItem[];
}

export interface PlannerSkillIndexItem {
	id: string;
	name: string;
	description: string;
	status: "active";
	tags: string[];
	sourceKind: PlannerSkillSourceKind;
	sourcePlanId: string | null;
	sourceTaskId: string | null;
	language: string;
	skillPath: string;
	createdAt: number;
	updatedAt: number;
	hash: string;
}

export interface PlannerSkillCreateInput {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	params: unknown;
	now?: number;
	uuid?: string;
}

export interface PlannerSkillCreateResult {
	status: "applied" | "blocked";
	toolName: PlannerSkillToolName;
	text: string;
	details: {
		indexPath: string;
		skillPath: string;
		item: PlannerSkillIndexItem;
	} | null;
}

export function createPlannerSkillStoragePaths(
	projectPaths: ProjectStoragePaths,
) {
	const skillsDir = join(projectPaths.extensionDir, "skills");
	return {
		skillsDir,
		libraryDir: join(skillsDir, "library"),
		indexJson: join(skillsDir, "index.json"),
	};
}

export async function listActivePlannerSkillPaths(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<string[]> {
	const paths = createPlannerSkillStoragePaths(input.projectPaths);
	const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
	const existing: string[] = [];
	for (const item of index.items) {
		if (item.status !== "active") continue;
		if (await input.fs.exists(item.skillPath)) {
			existing.push(item.skillPath);
		}
	}
	return existing;
}

export async function executePlannerSkillTool(
	input: PlannerSkillCreateInput,
): Promise<PlannerSkillCreateResult> {
	try {
		const params = parseSkillCreateParams(input.params);
		const settings = await loadEffectivePlannerSettings({
			fs: input.fs,
			projectPaths: input.projectPaths,
		});
		const language = settings.effective.metadata.skillLanguage;
		const id = createPlannerSkillId(
			params.nameHint,
			input.uuid ?? randomUUID(),
		);
		const paths = createPlannerSkillStoragePaths(input.projectPaths);
		const skillDir = join(paths.libraryDir, id);
		const skillPath = join(skillDir, "SKILL.md");
		const content = formatPlannerSkillMarkdown({
			name: id,
			description: params.description,
			bodyMarkdown: params.bodyMarkdown,
		});
		const hash = createHash("sha256")
			.update(`${params.description}\n\n${params.bodyMarkdown}`)
			.digest("hex");
		const now = input.now ?? Date.now();
		const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
		const existing = index.items.find(
			(item) => item.hash === hash || item.name === id,
		);
		if (existing) {
			return blocked(
				`Planner skill already exists: ${existing.name}.\nSkill path: ${existing.skillPath}`,
			);
		}

		const item: PlannerSkillIndexItem = {
			id,
			name: id,
			description: params.description,
			status: "active",
			tags: params.tags,
			sourceKind: params.sourceKind,
			sourcePlanId: params.sourcePlanId,
			sourceTaskId: params.sourceTaskId,
			language,
			skillPath,
			createdAt: now,
			updatedAt: now,
			hash,
		};

		await input.fs.writeTextAtomic(skillPath, content);
		await writePlannerSkillIndex(input.fs, paths.indexJson, {
			version: 1,
			items: [...index.items, item],
		});

		return {
			status: "applied",
			toolName: "planner_skill_create",
			text: [
				"Planner skill saved for future planner sessions.",
				`Skill: ${id}`,
				`Skill path: ${skillPath}`,
				`Index: ${paths.indexJson}`,
				`Language: ${language}`,
				"Pi loads planner skills through resources_discover on the next planner session start, resume, or reload.",
				"Continue the current planner state from planner_status; this skill is future memory, not a replacement for the current stage instructions.",
			].join("\n"),
			details: { indexPath: paths.indexJson, skillPath, item },
		};
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

async function readPlannerSkillIndex(
	fs: PlannerFs,
	path: string,
): Promise<PlannerSkillIndex> {
	const index = await readJsonIfExists<PlannerSkillIndex>(fs, path);
	if (!index) {
		return { version: 1, items: [] };
	}
	if (index.version !== 1 || !Array.isArray(index.items)) {
		throw new TypeError(`Invalid planner skill index: ${path}`);
	}
	return {
		version: 1,
		items: index.items.filter(isPlannerSkillIndexItem),
	};
}

async function writePlannerSkillIndex(
	fs: PlannerFs,
	path: string,
	index: PlannerSkillIndex,
): Promise<void> {
	await writeJson(fs, path, {
		version: 1,
		items: [...index.items].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
	});
}

function parseSkillCreateParams(value: unknown): {
	nameHint: string;
	description: string;
	bodyMarkdown: string;
	tags: string[];
	sourceKind: PlannerSkillSourceKind;
	sourcePlanId: string | null;
	sourceTaskId: string | null;
} {
	const record = asObject(value);
	const nameHint = requiredString(record, "nameHint");
	const description = requiredString(record, "description");
	const bodyMarkdown = requiredString(record, "bodyMarkdown");
	const sourceKind = enumParam(
		record,
		"sourceKind",
		PLANNER_SKILL_SOURCE_KINDS,
	);
	const tags = stringArray(record.tags, "tags").map(normalizeTag);
	if (description.length > 1024) {
		throw new TypeError(
			"planner_skill_create.description must be <= 1024 characters.",
		);
	}
	if (
		bodyMarkdown.includes("\n---\n") ||
		bodyMarkdown.trimStart().startsWith("---")
	) {
		throw new TypeError(
			"planner_skill_create.bodyMarkdown must not include YAML frontmatter. The wrapper writes name and description.",
		);
	}
	if (!/^#\s+\S/m.test(bodyMarkdown)) {
		throw new TypeError(
			"planner_skill_create.bodyMarkdown must contain a markdown H1 heading.",
		);
	}
	return {
		nameHint,
		description: normalizeDescription(description),
		bodyMarkdown: bodyMarkdown.trim(),
		tags,
		sourceKind,
		sourcePlanId: optionalString(record, "sourcePlanId"),
		sourceTaskId: optionalString(record, "sourceTaskId"),
	};
}

function formatPlannerSkillMarkdown(input: {
	name: string;
	description: string;
	bodyMarkdown: string;
}): string {
	return [
		"---",
		`name: ${input.name}`,
		"description: >",
		...foldYamlText(input.description).map((line) => `  ${line}`),
		"---",
		"",
		input.bodyMarkdown.trim(),
		"",
	].join("\n");
}

function createPlannerSkillId(nameHint: string, uuid: string): string {
	const slug = slugify(nameHint);
	const suffix = uuid.replace(/-/g, "").slice(0, 8).toLowerCase();
	const maxSlugLength = 64 - "pi-planner--".length - suffix.length;
	return `pi-planner-${slug.slice(0, maxSlugLength).replace(/-+$/g, "")}-${suffix}`;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
	return slug || "skill";
}

function normalizeDescription(value: string): string {
	return [...value.trim().replace(/\s+/g, " ")]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("");
}

function normalizeTag(value: string): string {
	return slugify(value).slice(0, 40) || "tag";
}

function foldYamlText(value: string): string[] {
	const words = value.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (next.length > 88 && current) {
			lines.push(current);
			current = word;
		} else {
			current = next;
		}
	}
	if (current) lines.push(current);
	return lines.length ? lines : ["Use for a verified planner workflow lesson."];
}

function stringArray(value: unknown, key: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new TypeError(
			`planner_skill_create.${key} must be an array of strings.`,
		);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new TypeError(
				`planner_skill_create.${key}[${index}] must be a non-empty string.`,
			);
		}
		return entry.trim();
	});
}

function enumParam<T extends readonly string[]>(
	record: Record<string, unknown>,
	key: string,
	values: T,
): T[number] {
	const value = record[key];
	if (typeof value !== "string" || !values.includes(value)) {
		throw new TypeError(
			`planner_skill_create.${key} must be one of: ${values.join(", ")}.`,
		);
	}
	return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(
			`planner_skill_create.${key} must be a non-empty string.`,
		);
	}
	return value.trim();
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(
			`planner_skill_create.${key} must be a non-empty string when provided.`,
		);
	}
	return value.trim();
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("planner_skill_create parameters must be an object.");
	}
	return value as Record<string, unknown>;
}

function isPlannerSkillIndexItem(
	value: unknown,
): value is PlannerSkillIndexItem {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.description === "string" &&
		record.status === "active" &&
		Array.isArray(record.tags) &&
		typeof record.sourceKind === "string" &&
		typeof record.language === "string" &&
		typeof record.skillPath === "string" &&
		typeof record.createdAt === "number" &&
		typeof record.updatedAt === "number" &&
		typeof record.hash === "string"
	);
}

function blocked(text: string): PlannerSkillCreateResult {
	return {
		status: "blocked",
		toolName: "planner_skill_create",
		text,
		details: null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
