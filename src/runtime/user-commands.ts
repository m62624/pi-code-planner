import { errorMessage } from "../errors";
import { probeGitAvailability } from "../git/git-availability";
import type { GitRunner } from "../git/runner";
import { createPiSessionDir } from "../session/handoff";
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecordIfExists, savePlanRecord } from "../storage/plan-store";
import {
	readProjectRecordIfExists,
	saveProjectRecord,
	setActivePlan,
} from "../storage/project-store";
import type {
	PlanRecord,
	PlanStateRecord,
	PlanSummaryStatus,
	ProjectRecord,
} from "../storage/schema";
import { readPlanStateIfExists, savePlanState } from "../storage/state-store";
import { createWorktreeProjectIndexPath } from "../storage/worktree-index";
import { bootstrapPlanWorktree, resolveUniquePlanBranch } from "./plan-tools";
import type { PlannerToolContext } from "./tool-context";
import { asObject } from "./values";

export type PlannerUserCommandName =
	| "planner_get_plan_list"
	| "planner_rename"
	| "planner_resume"
	| "planner_delete";

export interface PlannerUserCommandInput extends PlannerToolContext {
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
	description: string | null;
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
			case "planner_resume":
				return await resumePlan(input);
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
}): Promise<{ project: ProjectRecord | null; plans: PlannerListEntry[] }> {
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return { project: null, plans: [] };
	}
	const plans = await buildPlanList(input.fs, input.projectPaths, project);
	return { project, plans };
}

async function listPlans(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return applied(input.commandName, formatPlanList([]), {
			project: null,
			plans: [],
		});
	}
	const plans = await buildPlanList(input.fs, input.projectPaths, project);
	return applied(input.commandName, formatPlanList(plans), { project, plans });
}

async function renamePlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return noProjectPlans(input.commandName);
	}
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

async function resumePlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const targetPlanId = requiredString(params, "planId");
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return noProjectPlans(input.commandName);
	}
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
				worktreePath: target.state?.worktreePath ?? null,
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
		// A plan persisted while git was unavailable has no worktree yet. Finish
		// creating it now that the user is back (git may have become available),
		// instead of treating it as broken and losing the saved request.
		if (target.state.worktreeBootstrapPending) {
			const rebootstrap = await rebootstrapPendingWorktree({
				fs: input.fs,
				git: input.git,
				projectPaths: input.projectPaths,
				commandName: input.commandName,
				planId: targetPlanId,
				state: target.state,
			});
			if (!rebootstrap.allow) {
				return rebootstrap.result;
			}
			target.state = rebootstrap.state;
		} else {
			return blocked(
				input.commandName,
				`Target planner worktree is missing: ${target.state.worktreePath}.`,
				{ target },
			);
		}
	}

	const nextProject = await setActivePlan(
		input.fs,
		input.projectPaths,
		targetPlanId,
	);
	return applied(input.commandName, `Planner plan resumed: ${targetPlanId}.`, {
		project: nextProject,
		target,
		worktreePath: target.state.worktreePath,
		creationMethod: target.state.creationMethod ?? "create",
		compatibilityMode: target.state.compatibilityMode ?? "additive",
	});
}

/**
 * Finish creating the git worktree for a plan that was persisted while git was
 * unavailable. Returns the promoted state on success, or a blocked result that
 * points at the saved request.md when git is still unavailable or the bootstrap
 * fails — so the request is never lost and the user can retry.
 */
async function rebootstrapPendingWorktree(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	commandName: PlannerUserCommandName;
	planId: string;
	state: PlanStateRecord;
}): Promise<
	| { allow: true; state: PlanStateRecord }
	| { allow: false; result: PlannerUserCommandResult }
> {
	const planPaths: PlanStoragePaths = createPlanStoragePaths(
		input.projectPaths,
		input.planId,
	);
	const worktreePath = input.state.worktreePath;
	if (!worktreePath) {
		return {
			allow: false,
			result: blocked(
				input.commandName,
				`Target planner plan has no worktreePath: ${input.planId}.`,
				{ planId: input.planId },
			),
		};
	}

	const availability = await probeGitAvailability({
		git: input.git,
		projectRoot: input.projectPaths.projectRoot,
	});
	if (!availability.installed || !availability.repository) {
		const detail = !availability.installed
			? "Git is not installed."
			: "No git repository was found here. Run `git init` first.";
		return {
			allow: false,
			result: blocked(
				input.commandName,
				[
					`${detail} The planner cannot finish creating the worktree for "${input.planId}" yet.`,
					`Your request is saved at: ${planPaths.requestMd}`,
					"Make git available and run /planner-resume again.",
				].join("\n"),
				{
					planId: input.planId,
					requestMd: planPaths.requestMd,
					worktreeBootstrapPending: true,
				},
			),
		};
	}

	try {
		const planBranch = await resolveUniquePlanBranch({
			git: input.git,
			repoRoot: input.projectPaths.projectRoot,
			planBranch: input.state.activeBranches.plan,
		});
		const { reality } = await bootstrapPlanWorktree({
			fs: input.fs,
			git: input.git,
			projectPaths: input.projectPaths,
			planId: input.planId,
			worktreeLocation: worktreePath,
			planBranch,
			baseBranch: input.state.activeBranches.base,
		});
		const nextState: PlanStateRecord = {
			...input.state,
			worktreeBootstrapPending: false,
			stage: "intake",
			step: "draft_goal",
			stepStatus: "running",
			currentBranch: reality.branch,
			activeBranches: { ...input.state.activeBranches, plan: planBranch },
		};
		await savePlanState(input.fs, planPaths, nextState);
		return { allow: true, state: nextState };
	} catch (error) {
		return {
			allow: false,
			result: blocked(
				input.commandName,
				[
					`The planner could not create the git worktree for "${input.planId}": ${errorMessage(error)}.`,
					`Your request is saved at: ${planPaths.requestMd}`,
					"Fix git and run /planner-resume again.",
				].join("\n"),
				{
					planId: input.planId,
					requestMd: planPaths.requestMd,
					error,
					worktreeBootstrapPending: true,
				},
			),
		};
	}
}

async function deletePlan(
	input: PlannerUserCommandInput,
): Promise<PlannerUserCommandResult> {
	const params = asObject(input.params);
	const planId = requiredString(params, "planId");
	const deleteSessions = booleanParam(params, "deleteSessions") ?? false;
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return noProjectPlans(input.commandName);
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
	const projectRootExists = await input.fs.exists(
		input.projectPaths.projectRoot,
	);
	const warnings: string[] = [];
	if (state) {
		if (state.worktreePath && (await input.fs.exists(state.worktreePath))) {
			if (projectRootExists) {
				const warning = await tryWorktreeRemove({
					git: input.git,
					repoRoot: input.projectPaths.projectRoot,
					path: state.worktreePath,
				});
				if (warning) warnings.push(warning);
			} else {
				await input.fs.removeDir(state.worktreePath);
			}
		}
		if (projectRootExists) {
			// Tolerate branches that were already removed (e.g. the worktree was
			// deleted by hand before this command). A hard failure here would abort
			// the whole deletion and leave the plan — and its stale branches — in
			// the list. Downgrade to a warning and prune the plan regardless.
			for (const branch of managedChildBranches(state)) {
				const warning = await tryDeleteManagedBranch({
					git: input.git,
					repoRoot: input.projectPaths.projectRoot,
					branch,
				});
				if (warning) warnings.push(warning);
			}
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
	const isActive = project.activePlanId === planId;
	const nextProject: ProjectRecord = {
		...project,
		activePlanId: isActive ? null : project.activePlanId,
		plans: project.plans.filter((plan) => plan.planId !== planId),
	};
	await saveProjectRecord(input.fs, input.projectPaths, nextProject);
	const text = [`Planner plan deleted: ${planId}.`, ...warnings].join("\n");
	return applied(input.commandName, text, {
		project: nextProject,
		planId,
		removedPlanDir: planPaths.planDir,
		projectRootExists,
		gitCleanupSkipped: !projectRootExists,
		warnings,
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
			description: plan?.description ?? summary.description ?? null,
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
				plan.description ? `:: ${plan.description}` : "",
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
	if (input.state.requiresUserDecision || input.state.broken) {
		return {
			allow: false,
			reason: `Planner plan requires recovery/user decision before resume/delete: ${input.planId}.`,
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
			reason: `Planner plan has dirty worktree and cannot be resumed/deleted: ${input.planId}.`,
		};
	}
	return { allow: true };
}

/** Delete a managed branch, tolerating one that is already gone. Returns a
 * warning string when the branch could not be deleted cleanly (already removed,
 * or git refused), so the caller can surface it and prune the plan regardless;
 * returns null on a clean delete. */
async function tryDeleteManagedBranch(input: {
	git: GitRunner;
	repoRoot: string;
	branch: string;
}): Promise<string | null> {
	try {
		const exists = await input.git.branchExists({
			repoRoot: input.repoRoot,
			branch: input.branch,
		});
		if (!exists) {
			return `Branch ${input.branch} was already gone — skipped and pruned from the plan registry.`;
		}
		await input.git.deleteBranch({
			repoRoot: input.repoRoot,
			branch: input.branch,
		});
		return null;
	} catch (error) {
		return `Branch ${input.branch} could not be deleted (${errorMessage(error)}); pruned from the plan registry anyway.`;
	}
}

/** Remove a worktree, tolerating one that git no longer tracks (e.g. it was
 * deleted by hand). Returns a warning string on failure, null on success. */
async function tryWorktreeRemove(input: {
	git: GitRunner;
	repoRoot: string;
	path: string;
}): Promise<string | null> {
	try {
		await input.git.worktreeRemove({
			repoRoot: input.repoRoot,
			path: input.path,
		});
		return null;
	} catch (error) {
		return `Worktree ${input.path} could not be removed via git (${errorMessage(error)}); continuing with deletion.`;
	}
}

function managedChildBranches(state: PlanStateRecord): string[] {
	const branches = [
		state.activeBranches.currentTask,
		...Object.values(state.managedBranches.tasks).flatMap((registry) => [
			registry.task,
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

function noProjectPlans(
	commandName: PlannerUserCommandName,
): PlannerUserCommandResult {
	return blocked(
		commandName,
		"No planner plans in this project. Create one with /planner-create first.",
		{ project: null },
	);
}
