import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { errorMessage } from "../errors";
import { isPathInsideOrEqual } from "../path-utils";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";
import type { ProjectStoragePaths } from "../storage/paths";
import { resolveProjectStoragePaths } from "../storage/project-resolver";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import { ensureBundledElenchusSkillPath } from "./elenchus-skill";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import type { PlannerToolContext } from "./tool-context";

export const PLANNER_SKILL_TOOL_NAMES = [
	"planner_skill_create",
	"planner_skill_update",
] as const;

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

export interface PlannerSkillSummary {
	name: string;
	description: string;
	sourceKind: PlannerSkillSourceKind;
	tags: string[];
	skillPath: string;
	updatedAt: number;
}

export interface PlannerSkillCreateInput extends PlannerToolContext {
	params: unknown;
	now?: number;
	uuid?: string;
}

export interface PlannerSkillUpdateInput extends PlannerToolContext {
	params: unknown;
	now?: number;
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
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (!settings.effective.skills.enabled) {
		return [];
	}
	const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
	const existing: string[] = [];
	const items = [...index.items].sort((left, right) => {
		const byUpdated = right.updatedAt - left.updatedAt;
		return byUpdated || left.name.localeCompare(right.name);
	});
	const maxActive = settings.effective.skills.maxActive;
	for (const item of maxActive > 0 ? items.slice(0, maxActive) : items) {
		if (item.status !== "active") continue;
		if (await input.fs.exists(item.skillPath)) {
			existing.push(item.skillPath);
		}
	}
	return existing;
}

export async function listActivePlannerSkillSummaries(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<PlannerSkillSummary[]> {
	const paths = createPlannerSkillStoragePaths(input.projectPaths);
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (!settings.effective.skills.enabled) {
		return [];
	}
	const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
	const items = [...index.items].sort((left, right) => {
		const byUpdated = right.updatedAt - left.updatedAt;
		return byUpdated || left.name.localeCompare(right.name);
	});
	const maxActive = settings.effective.skills.maxActive;
	const selected = maxActive > 0 ? items.slice(0, maxActive) : items;
	const summaries: PlannerSkillSummary[] = [];
	for (const item of selected) {
		if (item.status !== "active") continue;
		if (!(await input.fs.exists(item.skillPath))) continue;
		summaries.push({
			name: item.name,
			description: item.description,
			sourceKind: item.sourceKind,
			tags: item.tags,
			skillPath: item.skillPath,
			updatedAt: item.updatedAt,
		});
	}
	return summaries;
}

export async function listPlannerSkillInventory(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<PlannerSkillSummary[]> {
	const paths = createPlannerSkillStoragePaths(input.projectPaths);
	const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
	const items = [...index.items].sort((left, right) => {
		const byUpdated = right.updatedAt - left.updatedAt;
		return byUpdated || left.name.localeCompare(right.name);
	});
	const summaries: PlannerSkillSummary[] = [];
	for (const item of items) {
		if (item.status !== "active") continue;
		if (!(await input.fs.exists(item.skillPath))) continue;
		summaries.push({
			name: item.name,
			description: item.description,
			sourceKind: item.sourceKind,
			tags: item.tags,
			skillPath: item.skillPath,
			updatedAt: item.updatedAt,
		});
	}
	return summaries;
}

export async function deletePlannerSkill(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	name: string;
}): Promise<PlannerSkillSummary | null> {
	const paths = createPlannerSkillStoragePaths(input.projectPaths);
	const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
	const item = index.items.find((entry) => entry.name === input.name);
	if (!item) {
		return null;
	}
	const skillDir = dirname(item.skillPath);
	if (!isPathInsideOrEqual(skillDir, paths.libraryDir)) {
		throw new TypeError(
			`Refusing to delete planner skill outside library: ${item.skillPath}`,
		);
	}
	await input.fs.removeDir(skillDir);
	await writePlannerSkillIndex(input.fs, paths.indexJson, {
		version: 1,
		items: index.items.filter((entry) => entry.name !== item.name),
	});
	return {
		name: item.name,
		description: item.description,
		sourceKind: item.sourceKind,
		tags: item.tags,
		skillPath: item.skillPath,
		updatedAt: item.updatedAt,
	};
}

export async function listActivePlannerSkillPathsForCwd(input: {
	fs: PlannerFs;
	agentDir: string;
	cwd: string;
}): Promise<string[]> {
	const projectPaths = await resolveProjectStoragePaths({
		fs: input.fs,
		agentDir: input.agentDir,
		cwd: input.cwd,
	});
	return await listActivePlannerSkillPaths({
		fs: input.fs,
		projectPaths,
	});
}

export async function listPlannerSkillResourcePaths(input: {
	fs: PlannerFs;
	agentDir: string;
	cwd: string;
	plannerActive: boolean;
}): Promise<string[]> {
	if (!input.plannerActive) {
		return [];
	}
	const projectPaths = await resolveProjectStoragePaths({
		fs: input.fs,
		agentDir: input.agentDir,
		cwd: input.cwd,
	});
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths,
	});
	// The master switch disables every planner-served skill, including the
	// bundled elenchus one.
	if (!settings.effective.skills.enabled) {
		return [];
	}
	const userSkills = await listActivePlannerSkillPaths({
		fs: input.fs,
		projectPaths,
	});
	// Prepend the bundled, version-matched elenchus skill so it takes priority
	// (and is not subject to the user-skill maxActive cap). A wasm load or write
	// failure must never break discovery — fall back to the user skills.
	let bundled: string | null = null;
	try {
		bundled = await ensureBundledElenchusSkillPath({
			fs: input.fs,
			agentDir: input.agentDir,
		});
	} catch {
		bundled = null;
	}
	return bundled ? [bundled, ...userSkills] : userSkills;
}

export async function executePlannerSkillTool(
	input: PlannerSkillCreateInput,
): Promise<PlannerSkillCreateResult> {
	try {
		const orchestrator = await runPlannerOrchestrator(input);
		if (orchestrator.preflight.context.status !== "ready") {
			return blocked(orchestrator.preflight.context.reason);
		}
		const policy = checkPlannerOrchestratorToolAllowed({
			orchestrator,
			toolName: "planner_skill_create",
		});
		if (!policy.allow) {
			return blocked(
				policy.reason ?? "planner_skill_create is blocked by planner state.",
			);
		}

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
		const skillValidation = validatePlannerSkillMarkdown(content);
		if (!skillValidation.valid) {
			throw new TypeError(skillValidation.reason);
		}
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
				"",
				formatArtifactEcho({
					canonicalSchema: ARTIFACT_CANONICAL_SCHEMA.planner_skill_create,
					writtenMarkdown: content,
				}),
				"",
				"Pi loads planner skills through resources_discover on the next planner session start, resume, or reload.",
				"Continue the current planner state from planner_status; this skill is future memory, not a replacement for the current stage instructions.",
			].join("\n"),
			details: { indexPath: paths.indexJson, skillPath, item },
		};
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

export async function executePlannerSkillUpdateTool(
	input: PlannerSkillUpdateInput,
): Promise<PlannerSkillCreateResult> {
	try {
		const orchestrator = await runPlannerOrchestrator(input);
		if (orchestrator.preflight.context.status !== "ready") {
			return blocked(orchestrator.preflight.context.reason);
		}
		const policy = checkPlannerOrchestratorToolAllowed({
			orchestrator,
			toolName: "planner_skill_update",
		});
		if (!policy.allow) {
			return blocked(
				policy.reason ?? "planner_skill_update is blocked by planner state.",
			);
		}

		const params = parseSkillUpdateParams(input.params);
		const paths = createPlannerSkillStoragePaths(input.projectPaths);
		const settings = await loadEffectivePlannerSettings({
			fs: input.fs,
			projectPaths: input.projectPaths,
		});
		const language = settings.effective.metadata.skillLanguage;
		const index = await readPlannerSkillIndex(input.fs, paths.indexJson);
		const existing = index.items.find((item) => item.name === params.name);
		if (!existing) {
			return blocked(
				`Planner skill not found: ${params.name}.\nUse planner_skill_create to add a new skill, or check the name in the skill index.`,
			);
		}

		const content = formatPlannerSkillMarkdown({
			name: existing.name,
			description: params.description,
			bodyMarkdown: params.bodyMarkdown,
		});
		const skillValidation = validatePlannerSkillMarkdown(content);
		if (!skillValidation.valid) {
			throw new TypeError(skillValidation.reason);
		}
		const hash = createHash("sha256")
			.update(`${params.description}\n\n${params.bodyMarkdown}`)
			.digest("hex");
		const now = input.now ?? Date.now();

		const updated: PlannerSkillIndexItem = {
			...existing,
			description: params.description,
			hash,
			updatedAt: now,
			language,
		};

		await input.fs.writeTextAtomic(existing.skillPath, content);
		await writePlannerSkillIndex(input.fs, paths.indexJson, {
			version: 1,
			items: index.items.map((item) =>
				item.name === params.name ? updated : item,
			),
		});

		return {
			status: "applied",
			toolName: "planner_skill_update",
			text: [
				"Planner skill updated.",
				`Skill: ${existing.name}`,
				`Skill path: ${existing.skillPath}`,
				`Index: ${paths.indexJson}`,
				`Language: ${language}`,
				"",
				formatArtifactEcho({
					canonicalSchema: ARTIFACT_CANONICAL_SCHEMA.planner_skill_update,
					writtenMarkdown: content,
				}),
				"",
				"Pi loads updated skills through resources_discover on the next planner session start, resume, or reload.",
			].join("\n"),
			details: {
				indexPath: paths.indexJson,
				skillPath: existing.skillPath,
				item: updated,
			},
		};
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

function parseSkillUpdateParams(value: unknown): {
	name: string;
	description: string;
	bodyMarkdown: string;
} {
	const record = asObject(value);
	const name = requiredString(record, "name");
	const description = requiredString(record, "description");
	const bodyMarkdown = requiredString(record, "bodyMarkdown");
	if (description.length > 1024) {
		throw new TypeError(
			"planner_skill_update.description must be <= 1024 characters.",
		);
	}
	if (
		bodyMarkdown.includes("\n---\n") ||
		bodyMarkdown.trimStart().startsWith("---")
	) {
		throw new TypeError(
			"planner_skill_update.bodyMarkdown must not include YAML frontmatter.",
		);
	}
	if (!/^#\s+\S/m.test(bodyMarkdown)) {
		throw new TypeError(
			"planner_skill_update.bodyMarkdown must contain a markdown H1 heading.",
		);
	}
	return {
		name,
		description: normalizeDescription(description),
		bodyMarkdown: bodyMarkdown.trim(),
	};
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

export function validatePlannerSkillMarkdown(content: string):
	| {
			valid: true;
			name: string;
			description: string;
	  }
	| {
			valid: false;
			reason: string;
	  } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0] !== "---") {
		return invalidSkill(
			"SKILL.md must start with an exact --- frontmatter delimiter.",
		);
	}
	const endIndex = lines.indexOf("---", 1);
	if (endIndex === -1) {
		return invalidSkill(
			"SKILL.md frontmatter must end with an exact --- delimiter.",
		);
	}
	const frontmatter = lines.slice(1, endIndex);
	const body = lines
		.slice(endIndex + 1)
		.join("\n")
		.trim();
	if (!/^#\s+\S/m.test(body)) {
		return invalidSkill(
			"SKILL.md body must contain a markdown H1 heading after frontmatter.",
		);
	}
	const parsed = parsePlannerSkillFrontmatter(frontmatter);
	if (!parsed.valid) return parsed;
	if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(parsed.name)) {
		return invalidSkill(
			"SKILL.md name must be 1-64 chars, lowercase a-z, digits, and single hyphens; no leading/trailing hyphen.",
		);
	}
	if (parsed.name.includes("--")) {
		return invalidSkill("SKILL.md name must not contain consecutive hyphens.");
	}
	if (!parsed.description.trim()) {
		return invalidSkill("SKILL.md description is required.");
	}
	if (parsed.description.length > 1024) {
		return invalidSkill("SKILL.md description must be <= 1024 characters.");
	}
	return { valid: true, name: parsed.name, description: parsed.description };
}

function parsePlannerSkillFrontmatter(
	lines: string[],
):
	| { valid: true; name: string; description: string }
	| { valid: false; reason: string } {
	if (lines.length < 2) {
		return invalidSkill(
			"SKILL.md frontmatter must contain name and description.",
		);
	}
	const nameLine = lines[0];
	if (!nameLine.startsWith("name: ")) {
		return invalidSkill(
			"SKILL.md first frontmatter field must be: name: <skill-name>.",
		);
	}
	const name = nameLine.slice("name: ".length).trim();
	const descriptionLine = lines[1];
	if (descriptionLine.startsWith("description: >")) {
		if (descriptionLine !== "description: >") {
			return invalidSkill(
				"Multiline SKILL.md description must use exactly: description: >",
			);
		}
		const descriptionLines = lines.slice(2);
		if (descriptionLines.length === 0) {
			return invalidSkill(
				"Multiline SKILL.md description must contain indented text.",
			);
		}
		for (const [index, line] of descriptionLines.entries()) {
			if (!line.startsWith("  ")) {
				return invalidSkill(
					`Multiline SKILL.md description line ${index + 1} must be indented with two spaces.`,
				);
			}
			if (line.startsWith("   ")) {
				return invalidSkill(
					`Multiline SKILL.md description line ${index + 1} must use exactly two leading spaces.`,
				);
			}
			if (line.includes("\t")) {
				return invalidSkill(
					`Multiline SKILL.md description line ${index + 1} must not contain tabs.`,
				);
			}
		}
		return {
			valid: true,
			name,
			description: descriptionLines
				.map((line) => line.slice(2).trim())
				.join(" ")
				.replace(/\s+/g, " ")
				.trim(),
		};
	}
	if (descriptionLine.startsWith("description: ")) {
		if (lines.length !== 2) {
			return invalidSkill(
				"Single-line SKILL.md description must not have extra frontmatter lines.",
			);
		}
		return {
			valid: true,
			name,
			description: descriptionLine.slice("description: ".length).trim(),
		};
	}
	return invalidSkill(
		"SKILL.md second frontmatter field must be description: <text> or description: >.",
	);
}

function invalidSkill(reason: string): { valid: false; reason: string } {
	return { valid: false, reason };
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
		.replace(/^-+|(?<!-)-+$/g, "")
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
