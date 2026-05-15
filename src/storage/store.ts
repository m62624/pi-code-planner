import { basename, normalize } from "node:path";
import type { PlannerFs } from "../settings/fs";
import { writeJsonAtomic } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import {
	createAttemptId,
	createPlanId,
	createProjectKey,
	createWorkItemId,
} from "./ids";
import {
	getAttemptStoragePaths,
	getPlanStoragePaths,
	getProjectStoragePaths,
	getWorkItemStoragePaths,
} from "./paths";
import type {
	ExperimentAttemptRecord,
	ExperimentAttemptStatus,
	PlanRecord,
	PlanStatus,
	ProjectRecord,
	WorkItemRecord,
	WorkItemStatus,
} from "./schema";

export interface PlannerStorageOptions {
	paths: Pick<SettingsPaths, "globalDir">;
	fs: PlannerFs;
	now?: () => string;
}

export interface CreatePlanInput {
	title: string;
	planId?: string;
	status?: PlanStatus;
}

export interface CreateWorkItemInput {
	title: string;
	workItemId?: string;
	status?: WorkItemStatus;
}

export interface CreateAttemptInput {
	attemptId?: string;
	attemptIndex?: number;
	status?: ExperimentAttemptStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
	if (!Object.hasOwn(value, key) || typeof value[key] !== "string") {
		throw new Error(`Invalid storage record field: ${key}`);
	}
	return value[key];
}

function readVersion(value: Record<string, unknown>): 1 {
	if (value.version !== 1) {
		throw new Error("Invalid storage record field: version");
	}
	return 1;
}

function readEnum<T extends string>(
	value: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T {
	const raw = readString(value, key);
	if (!allowed.includes(raw as T)) {
		throw new Error(`Invalid storage record field: ${key}`);
	}
	return raw as T;
}

const PLAN_STATUSES = [
	"draft",
	"active",
	"blocked",
	"completed",
	"cancelled",
	"archived",
] as const;

const WORK_ITEM_STATUSES = [
	"pending",
	"active",
	"review",
	"completed",
	"blocked",
	"failed",
	"skipped",
] as const;

const ATTEMPT_STATUSES = [
	"created",
	"active",
	"candidate",
	"selected",
	"rejected",
	"deleted",
] as const;

function parseJsonRecord(fs: PlannerFs, path: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFile(path)) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Invalid storage record: ${path}`);
	}
	return parsed;
}

export function parseProjectRecord(value: unknown): ProjectRecord {
	if (!isRecord(value)) throw new Error("Invalid project record.");
	return {
		version: readVersion(value),
		projectKey: readString(value, "projectKey"),
		name: readString(value, "name"),
		rootPath: readString(value, "rootPath"),
		createdAt: readString(value, "createdAt"),
		updatedAt: readString(value, "updatedAt"),
	};
}

export function parsePlanRecord(value: unknown): PlanRecord {
	if (!isRecord(value)) throw new Error("Invalid plan record.");
	return {
		version: readVersion(value),
		projectKey: readString(value, "projectKey"),
		planId: readString(value, "planId"),
		title: readString(value, "title"),
		status: readEnum(value, "status", PLAN_STATUSES),
		createdAt: readString(value, "createdAt"),
		updatedAt: readString(value, "updatedAt"),
	};
}

export function parseWorkItemRecord(value: unknown): WorkItemRecord {
	if (!isRecord(value)) throw new Error("Invalid work item record.");
	return {
		version: readVersion(value),
		planId: readString(value, "planId"),
		workItemId: readString(value, "workItemId"),
		title: readString(value, "title"),
		status: readEnum(value, "status", WORK_ITEM_STATUSES),
		createdAt: readString(value, "createdAt"),
		updatedAt: readString(value, "updatedAt"),
	};
}

export function parseExperimentAttemptRecord(
	value: unknown,
): ExperimentAttemptRecord {
	if (!isRecord(value)) throw new Error("Invalid experiment attempt record.");
	return {
		version: readVersion(value),
		planId: readString(value, "planId"),
		workItemId: readString(value, "workItemId"),
		attemptId: readString(value, "attemptId"),
		status: readEnum(value, "status", ATTEMPT_STATUSES),
		createdAt: readString(value, "createdAt"),
		updatedAt: readString(value, "updatedAt"),
	};
}

function writeIfMissing(fs: PlannerFs, path: string, content = ""): void {
	if (!fs.exists(path)) {
		fs.writeFile(path, content);
	}
}

function writeNewJson(fs: PlannerFs, path: string, value: unknown): void {
	if (fs.exists(path)) {
		throw new Error(`Storage record already exists: ${path}`);
	}
	writeJsonAtomic(fs, path, value);
}

export class PlanStore {
	constructor(private options: PlannerStorageOptions) {}

	ensureProject(projectPath: string): ProjectRecord {
		const paths = getProjectStoragePaths({
			paths: this.options.paths,
			projectPath,
		});
		if (this.options.fs.exists(paths.projectRecord)) {
			return this.readProject(projectPath);
		}

		const now = this.now();
		const rootPath = normalize(projectPath);
		const record: ProjectRecord = {
			version: 1,
			projectKey: createProjectKey(rootPath),
			name: basename(rootPath),
			rootPath,
			createdAt: now,
			updatedAt: now,
		};
		this.options.fs.mkdirp(paths.projectMemoryDir);
		this.options.fs.mkdirp(paths.plansDir);
		writeJsonAtomic(this.options.fs, paths.projectRecord, record);
		return record;
	}

	readProject(projectPath: string): ProjectRecord {
		const paths = getProjectStoragePaths({
			paths: this.options.paths,
			projectPath,
		});
		return parseProjectRecord(
			parseJsonRecord(this.options.fs, paths.projectRecord),
		);
	}

	createPlan(projectPath: string, input: CreatePlanInput): PlanRecord {
		const project = this.ensureProject(projectPath);
		const planId =
			input.planId ?? createPlanId(input.title, new Date(this.now()));
		const paths = getPlanStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
		});
		const now = this.now();
		const record: PlanRecord = {
			version: 1,
			projectKey: project.projectKey,
			planId,
			title: input.title,
			status: input.status ?? "draft",
			createdAt: now,
			updatedAt: now,
		};

		this.options.fs.mkdirp(paths.workItemsDir);
		writeNewJson(this.options.fs, paths.planRecord, record);
		writeIfMissing(this.options.fs, paths.planMarkdown);
		writeIfMissing(this.options.fs, paths.planDiscovery);
		writeIfMissing(this.options.fs, paths.planQuestions);
		writeIfMissing(this.options.fs, paths.planDecisions);
		return record;
	}

	readPlan(projectPath: string, planId: string): PlanRecord {
		const paths = getPlanStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
		});
		return parsePlanRecord(parseJsonRecord(this.options.fs, paths.planRecord));
	}

	createWorkItem(
		projectPath: string,
		planId: string,
		input: CreateWorkItemInput,
	): WorkItemRecord {
		this.readPlan(projectPath, planId);
		const workItemId = input.workItemId ?? createWorkItemId(input.title);
		const paths = getWorkItemStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
		});
		const now = this.now();
		const record: WorkItemRecord = {
			version: 1,
			planId,
			workItemId,
			title: input.title,
			status: input.status ?? "pending",
			createdAt: now,
			updatedAt: now,
		};

		this.options.fs.mkdirp(paths.experimentsDir);
		writeNewJson(this.options.fs, paths.workItemRecord, record);
		writeIfMissing(this.options.fs, paths.workItemTddPlan);
		writeIfMissing(this.options.fs, paths.workItemTestsSummary);
		writeIfMissing(this.options.fs, paths.workItemRefactorNotes);
		return record;
	}

	readWorkItem(
		projectPath: string,
		planId: string,
		workItemId: string,
	): WorkItemRecord {
		const paths = getWorkItemStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
		});
		return parseWorkItemRecord(
			parseJsonRecord(this.options.fs, paths.workItemRecord),
		);
	}

	createAttempt(
		projectPath: string,
		planId: string,
		workItemId: string,
		input: CreateAttemptInput = {},
	): ExperimentAttemptRecord {
		this.readWorkItem(projectPath, planId, workItemId);
		const attemptId =
			input.attemptId ?? createAttemptId(input.attemptIndex ?? 1);
		const paths = getAttemptStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
			attemptId,
		});
		const now = this.now();
		const record: ExperimentAttemptRecord = {
			version: 1,
			planId,
			workItemId,
			attemptId,
			status: input.status ?? "created",
			createdAt: now,
			updatedAt: now,
		};

		this.options.fs.mkdirp(paths.attemptDir);
		writeNewJson(this.options.fs, paths.attemptRecord, record);
		writeIfMissing(this.options.fs, paths.attemptPlan);
		writeIfMissing(this.options.fs, paths.attemptPrompt);
		writeIfMissing(this.options.fs, paths.attemptSummary);
		writeIfMissing(this.options.fs, paths.attemptScore, "{}\n");
		writeIfMissing(this.options.fs, paths.attemptVerification, "{}\n");
		writeIfMissing(this.options.fs, paths.attemptChangedFiles, "[]\n");
		return record;
	}

	readAttempt(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
	): ExperimentAttemptRecord {
		const paths = getAttemptStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
			attemptId,
		});
		return parseExperimentAttemptRecord(
			parseJsonRecord(this.options.fs, paths.attemptRecord),
		);
	}

	private now(): string {
		return this.options.now?.() ?? new Date().toISOString();
	}
}
