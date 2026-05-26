import type { GitRunner } from "../git/runner";
import { createPiSessionDir } from "../session/handoff";
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecordIfExists, savePlanRecord } from "../storage/plan-store";
import {
	readProjectRecord,
	saveProjectRecord,
	setActivePlan,
} from "../storage/project-store";
import type {
	PlanRecord,
	PlanStateRecord,
	PlanSummaryStatus,
	ProjectRecord,
} from "../storage/schema";
import { readPlanStateIfExists } from "../storage/state-store";
import { createWorktreeProjectIndexPath } from "../storage/worktree-index";

export type PlannerUserCommandName =
	| "planner_get_plan_list"
	| "planner_rename"
	| "planner_switch"
	| "planner_delete";

export interface PlannerUserCommandInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	commandName: PlannerUserCommandName;
	params: unknown;
}

export interface PlannerUserCommandResult {
	status: "applied" | "blocked";
	commandName: PlannerUserCommandName;
	text: string;
	details: unknown;
}

export interface PlannerListEntry {
	planId: string;
	title: string;
	status: PlanSummaryStatus;
	active: boolean;
	stage: string | null;
	step: string | null;
	worktreePath: string | null;
	broken: boolean;
	reason: string | null;
}

export async function executePlannerUserCommand(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	try {
		switch (input.commandName) {
			case "planner_get_plan_list":
				return await listPlans(input);
			case "planner_rename":
				return await renamePlan(input);
			case "planner_switch":
				return await switchPlan(input);
			case "planner_delete":
				return await deletePlan(input);
		}
	} catch (error) {
		return blocked(input.commandName, errorMessage(error), { error });
	}
}

export async function readPlannerPlanList(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<{ project: ProjectRecord; plans: PlannerListEntry[] }> {
	const project = await readProjectRecord(input.fs, input.projectPaths);
	const plans = await buildPlanList(input.fs, input.projectPaths, project);
	return { project, plans };
}

async function listPlans(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const project = await readProjectRecord(input.fs, input.projectPaths);
	const plans = await buildPlanList(input.fs, input.projectPaths, project);
	return applied(input.commandName, formatPlanList(plans), { project, plans });
}

async function renamePlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const project = await readProjectRecord(input.fs, input.projectPaths);
	const planId = optionalString(params, "planId") ?? project.activePlanId;
	const title = requiredString(params, "title");
	if (!planId) {
		return blocked(input.commandName, "No active planner plan to rename.", {
			project,
		});
	}
	const summary = project.plans.find((plan) => plan.planId === planId);
	if (!summary) {
		return blocked(
			input.commandName,
			`Planner plan does not exist: ${planId}.`,
			{
				project,
				planId,
			},
		);
	}

	const planPaths = createPlanStoragePaths(input.projectPaths, planId);
	const plan = await readPlanRecordIfExists(input.fs, planPaths);
	if (!plan) {
		return blocked(
			input.commandName,
			`Planner plan record is missing: ${planId}.`,
			{
				planPaths,
			},
		);
	}

	const nextPlan: PlanRecord = { ...plan, title };
	const nextProject: ProjectRecord = {
		...project,
		plans: project.plans.map((entry) =>
			entry.planId === planId ? { ...entry, title } : entry,
		),
	};
	await savePlanRecord(input.fs, planPaths, nextPlan);
	await saveProjectRecord(input.fs, input.projectPaths, nextProject);
	return applied(input.commandName, `Planner plan renamed: ${planId}.`, {
		project: nextProject,
		plan: nextPlan,
	});
}

async function switchPlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const targetPlanId = requiredString(params, "planId");
	const project = await readProjectRecord(input.fs, input.projectPaths);
	const targetSummary = project.plans.find(
		(plan) => plan.planId === targetPlanId,
	);
	if (!targetSummary) {
		return blocked(
			input.commandName,
			`Planner plan does not exist: ${targetPlanId}.`,
			{ project, targetPlanId },
		);
	}
	if (project.activePlanId === targetPlanId) {
		const target = await readPlanStateForCommand(
			input.fs,
			input.projectPaths,
			targetPlanId,
		);
		return applied(
			input.commandName,
			`Planner plan already active: ${targetPlanId}.`,
			{
				project,
				target,
			},
		);
	}

	const current = project.activePlanId
		? await readPlanStateForCommand(
				input.fs,
				input.projectPaths,
				project.activePlanId,
			)
		: null;
	if (current?.state) {
		const currentGuard = await assertPlanSwitchable({
			fs: input.fs,
			git: input.git,
			projectPaths: input.projectPaths,
			planId: project.activePlanId ?? "",
			state: current.state,
		});
		if (!currentGuard.allow) {
			return blocked(input.commandName, currentGuard.reason, {
				project,
				current,
			});
		}
	}

	const target = await readPlanStateForCommand(
		input.fs,
		input.projectPaths,
		targetPlanId,
	);
	if (!target.state?.worktreePath) {
		return blocked(
			input.commandName,
			`Target planner plan has no worktreePath: ${targetPlanId}.`,
			{ target },
		);
	}
	if (!(await input.fs.exists(target.state.worktreePath))) {
		return blocked(
			input.commandName,
			`Target planner worktree is missing: ${target.state.worktreePath}.`,
			{ target },
		);
	}

	const nextProject = await setActivePlan(
		input.fs,
		input.projectPaths,
		targetPlanId,
	);
	return applied(input.commandName, `Planner plan switched: ${targetPlanId}.`, {
		project: nextProject,
		target,
		worktreePath: target.state.worktreePath,
	});
}

async function deletePlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const planId = requiredString(params, "planId");
	const forceActive = booleanParam(params, "forceActive") ?? false;
	const deleteSessions = booleanParam(params, "deleteSessions") ?? false;
	const project = await readProjectRecord(input.fs, input.projectPaths);
	const isActive = project.activePlanId === planId;
	if (isActive && !forceActive) {
		return blocked(
			input.commandName,
			`Active planner plan cannot be deleted without --force-active: ${planId}.`,
			{ project, planId },
		);
	}
	const summary = project.plans.find((plan) => plan.planId === planId);
	if (!summary) {
		return blocked(
			input.commandName,
			`Planner plan does not exist: ${planId}.`,
			{
				project,
				planId,
			},
		);
	}

	const planPaths = createPlanStoragePaths(input.projectPaths, planId);
	const state = await readPlanStateIfExists(input.fs, planPaths);
	if (state) {
		if (!forceActive) {
			const guard = await assertPlanSwitchable({
				fs: input.fs,
				git: input.git,
				projectPaths: input.projectPaths,
				planId,
				state,
			});
			if (!guard.allow) {
				return blocked(input.commandName, guard.reason, { project, state });
			}
		}
		if (state.worktreePath && (await input.fs.exists(state.worktreePath))) {
			await input.git.worktreeRemove({
				repoRoot: input.projectPaths.projectRoot,
				path: state.worktreePath,
				force: forceActive,
			});
		}
		for (const branch of managedChildBranches(state)) {
			await input.git.deleteBranch({
				repoRoot: input.projectPaths.projectRoot,
				branch,
				force: forceActive,
			});
		}
		if (state.worktreePath) {
			await input.fs.removeFile(
				createWorktreeProjectIndexPath({
					agentDir: input.projectPaths.agentDir,
					worktreePath: state.worktreePath,
				}),
			);
			if (deleteSessions) {
				await input.fs.removeDir(
					createPiSessionDir({
						agentDir: input.projectPaths.agentDir,
						cwd: state.worktreePath,
					}),
				);
			}
		}
	}

	await input.fs.removeDir(planPaths.planDir);
	const nextProject: ProjectRecord = {
		...project,
		activePlanId: isActive ? null : project.activePlanId,
		plans: project.plans.filter((plan) => plan.planId !== planId),
	};
	await saveProjectRecord(input.fs, input.projectPaths, nextProject);
	return applied(input.commandName, `Planner plan deleted: ${planId}.`, {
		project: nextProject,
		planId,
		removedPlanDir: planPaths.planDir,
		forceActive,
	});
}

async function buildPlanList(
	fs: PlannerFs,
	projectPaths: ProjectStoragePaths,
	project: ProjectRecord,
): Promise<PlannerListEntry[]> {
	const entries: PlannerListEntry[] = [];
	for (const summary of project.plans) {
		const planPaths = createPlanStoragePaths(projectPaths, summary.planId);
		const plan = await readPlanRecordIfExists(fs, planPaths);
		const state = await readPlanStateIfExists(fs, planPaths);
		entries.push({
			planId: summary.planId,
			title: plan?.title ?? summary.title,
			status: summary.status,
			active: project.activePlanId === summary.planId,
			stage: state?.stage ?? null,
			step: state?.step ?? null,
			worktreePath: state?.worktreePath ?? null,
			broken: !plan || !state || state.broken,
			reason: !plan
				? "missing plan.json"
				: !state
					? "missing state.json"
					: state.brokenReason,
		});
	}
	return entries;
}

function formatPlanList(plans: readonly PlannerListEntry[]): string {
	if (plans.length === 0) {
		return "No planner plans in this project.";
	}
	return [
		"Planner plans:",
		...plans.map((plan) =>
			[
				plan.active ? "*" : "-",
				plan.planId,
				`[${plan.status}]`,
				plan.stage && plan.step ? `${plan.stage}/${plan.step}` : "missing",
				`- ${plan.title}`,
				plan.reason ? `(${plan.reason})` : "",
			]
				.filter(Boolean)
				.join(" "),
		),
	].join("\n");
}

async function readPlanStateForCommand(
	fs: PlannerFs,
	projectPaths: ProjectStoragePaths,
	planId: string,
): Promise<{
	planId: string;
	plan: PlanRecord | null;
	state: PlanStateRecord | null;
}> {
	const planPaths = createPlanStoragePaths(projectPaths, planId);
	const [plan, state] = await Promise.all([
		readPlanRecordIfExists(fs, planPaths),
		readPlanStateIfExists(fs, planPaths),
	]);
	return { planId, plan, state };
}

async function assertPlanSwitchable(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	planId: string;
	state: PlanStateRecord;
}): Promise<{ allow: true } | { allow: false; reason: string }> {
	if (input.state.stepStatus === "running") {
		return {
			allow: false,
			reason: `Planner plan is running and cannot be switched/deleted: ${input.planId}.`,
		};
	}
	if (input.state.requiresUserDecision || input.state.broken) {
		return {
			allow: false,
			reason: `Planner plan requires recovery/user decision before switch/delete: ${input.planId}.`,
		};
	}
	if (!input.state.worktreePath) {
		return { allow: true };
	}
	if (!(await input.fs.exists(input.state.worktreePath))) {
		return { allow: true };
	}
	const status = await input.git.statusPorcelain({
		repoRoot: input.state.worktreePath,
	});
	if (status.trim().length > 0) {
		return {
			allow: false,
			reason: `Planner plan has dirty worktree and cannot be switched/deleted: ${input.planId}.`,
		};
	}
	return { allow: true };
}

function managedChildBranches(state: PlanStateRecord): string[] {
	const branches = [
		state.activeBranches.currentTask,
		state.activeBranches.currentExperiment,
		state.activeBranches.selectedExperiment,
		...Object.values(state.managedBranches.tasks).flatMap((registry) => [
			registry.task,
			...registry.experiments,
			registry.selectedExperiment,
			registry.refactor,
		]),
	].filter((branch): branch is string => Boolean(branch));
	return [...new Set(branches)].filter((branch) => !branch.startsWith("plan/"));
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Missing required string parameter: ${key}.`);
	}
	return value.trim();
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function booleanParam(
	params: Record<string, unknown>,
	key: string,
): boolean | null {
	return typeof params[key] === "boolean" ? params[key] : null;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function applied(
	commandName: PlannerUserCommandName,
	text: string,
	details: unknown,
): PlannerUserCommandResult {
	return { status: "applied", commandName, text, details };
}

function blocked(
	commandName: PlannerUserCommandName,
	text: string,
	details: unknown,
): PlannerUserCommandResult {
	return { status: "blocked", commandName, text, details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
