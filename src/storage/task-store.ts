import { SCHEMA_VERSION } from "../constants";
import type { PlannerFs } from "./fs";
import { sanitizeIdPart } from "./ids";
import { readJson, writeJson } from "./json";
import {
	createTaskStoragePaths,
	type PlanStoragePaths,
	type TaskStoragePaths,
} from "./paths";
import type { TaskRecord, TaskStatus } from "./schema";

export interface UpsertTaskArtifactsInput {
	taskId: string;
	title: string;
	objective: string;
	scope: string[];
	acceptanceCriteria: string[];
	requirements?: string[];
	contractChain?: string[];
	relevantContracts?: string[];
	forbiddenAreas?: string[];
	domainDetails?: string[];
}

export async function upsertTaskArtifacts(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	input: UpsertTaskArtifactsInput,
): Promise<{ record: TaskRecord; paths: TaskStoragePaths }> {
	const taskId = requiredTaskId(input.taskId);
	const paths = createTaskStoragePaths(planPaths, taskId);
	const record: TaskRecord = {
		schemaVersion: SCHEMA_VERSION,
		taskId,
		title: requiredText(input.title, "title"),
		status: "pending",
		objective: requiredText(input.objective, "objective"),
		scope: stringArray(input.scope, "scope"),
		acceptanceCriteria: nonEmptyStringArray(
			input.acceptanceCriteria,
			"acceptanceCriteria",
		),
		requirements: stringArray(input.requirements ?? [], "requirements"),
		contractChain: stringArray(input.contractChain ?? [], "contractChain"),
		relevantContracts: stringArray(
			input.relevantContracts ?? [],
			"relevantContracts",
		),
		forbiddenAreas: stringArray(input.forbiddenAreas ?? [], "forbiddenAreas"),
		domainDetails: stringArray(input.domainDetails ?? [], "domainDetails"),
	};
	await fs.mkdirp(paths.taskDir);
	await writeJson(fs, paths.taskJson, record);
	await fs.writeTextAtomic(paths.taskMd, formatTaskMarkdown(record));
	for (const path of [paths.tddMd, paths.refactorMd]) {
		if (!(await fs.exists(path))) await fs.writeTextAtomic(path, "");
	}
	return { record, paths };
}

export async function readTaskRecord(
	fs: PlannerFs,
	paths: TaskStoragePaths,
): Promise<TaskRecord> {
	const record = await readJson<TaskRecord>(fs, paths.taskJson);
	// Legacy task.json files predate spec traceability; default the field so
	// every consumer can rely on it being an array.
	return { ...record, requirements: record.requirements ?? [] };
}

export async function updateTaskStatus(
	fs: PlannerFs,
	paths: TaskStoragePaths,
	status: TaskStatus,
	commitHash?: string,
): Promise<TaskRecord> {
	const current = await readTaskRecord(fs, paths);
	const next: TaskRecord = {
		...current,
		status,
		...(commitHash ? { commitHash } : {}),
	};
	await writeJson(fs, paths.taskJson, next);
	return next;
}

function formatTaskMarkdown(task: TaskRecord): string {
	return [
		`# ${task.title}`,
		"",
		"## Objective",
		"",
		task.objective,
		"",
		"## Scope",
		"",
		...list(task.scope, "(discover during TDD)"),
		"",
		"## Acceptance Criteria",
		"",
		...list(task.acceptanceCriteria),
		"",
		"## Spec Requirements",
		"",
		...list(task.requirements ?? [], "(no spec traceability recorded)"),
		"",
		"## TDD Rule",
		"",
		"Tests, mocks, fixtures, implementation, refactor, and final checks belong to this task lifecycle. Do not create a separate testing task.",
		"",
		"## Local Contract Context",
		"",
		"### Contract Chain",
		...list(task.contractChain ?? [], "(none recorded)"),
		"",
		"### Relevant Contracts",
		...list(task.relevantContracts ?? [], "(none recorded)"),
		"",
		"### Forbidden Areas",
		...list(task.forbiddenAreas ?? [], "(none recorded)"),
		"",
		"### Domain Details",
		...list(task.domainDetails ?? [], "(none recorded)"),
		"",
	].join("\n");
}

function list(values: readonly string[], empty = "(none)"): string[] {
	return values.length > 0
		? values.map((value) => `- ${value}`)
		: [`- ${empty}`];
}

function requiredTaskId(value: string): string {
	const normalized = requiredText(value, "taskId");
	if (
		normalized === "." ||
		normalized === ".." ||
		sanitizeIdPart(normalized) !== normalized
	) {
		throw new TypeError(
			"taskId must contain only lowercase ASCII letters, numbers, dots, underscores, or hyphens.",
		);
	}
	return normalized;
}

function requiredText(value: string, key: string): string {
	const normalized = value.trim();
	if (!normalized) throw new TypeError(`${key} must be a non-empty string.`);
	return normalized;
}

function stringArray(values: readonly string[], key: string): string[] {
	if (
		!Array.isArray(values) ||
		!values.every((value) => typeof value === "string")
	) {
		throw new TypeError(`${key} must be a string array.`);
	}
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nonEmptyStringArray(values: readonly string[], key: string): string[] {
	const normalized = stringArray(values, key);
	if (normalized.length === 0) {
		throw new TypeError(`${key} must contain at least one entry.`);
	}
	return normalized;
}
