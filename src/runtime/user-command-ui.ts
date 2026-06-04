import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlannerListEntry } from "./user-commands";
import { readPlannerPlanList } from "./user-commands";

export interface PlannerCommandUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(
		title: string,
		message: string,
		opts?: { timeout?: number },
	): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export async function selectPlannerPlanId(input: {
	ui: PlannerCommandUi;
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	title: string;
}): Promise<string | null> {
	const { plans } = await readPlannerPlanList({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	return await selectPlannerPlanIdFromList({
		ui: input.ui,
		plans,
		title: input.title,
	});
}

export async function selectPlannerPlanIdFromList(input: {
	ui: PlannerCommandUi;
	plans: readonly PlannerListEntry[];
	title: string;
}): Promise<string | null> {
	if (input.plans.length === 0) {
		input.ui.notify("No planner plans in this project.", "warning");
		return null;
	}
	const labels = input.plans.map(planOptionLabel);
	const choice = await input.ui.select(input.title, labels);
	if (!choice) return null;
	const index = labels.indexOf(choice);
	return index >= 0 ? (input.plans[index]?.planId ?? null) : null;
}

export async function confirmPlannerDelete(input: {
	ui: PlannerCommandUi;
	planId: string;
	active: boolean;
}): Promise<boolean> {
	return await input.ui.confirm(
		input.active ? "Delete active planner plan?" : "Delete planner plan?",
		input.active
			? `This will delete the active planner plan "${input.planId}", remove its worktree and related worktree chats, and abandon current planner progress.`
			: `Delete planner plan "${input.planId}", its worktree, planner files, and related worktree chats?`,
		input.active ? { timeout: 10_000 } : undefined,
	);
}

export async function inputPlannerRenameTitle(input: {
	ui: PlannerCommandUi;
}): Promise<string | null> {
	const title = await input.ui.input(
		"New planner title",
		"Enter new plan title",
	);
	if (!title?.trim()) {
		input.ui.notify("Planner rename cancelled.", "info");
		return null;
	}
	return title.trim();
}

export function planOptionLabel(plan: PlannerListEntry): string {
	const marker = plan.active ? "*" : "-";
	const position =
		plan.stage && plan.step ? `${plan.stage}/${plan.step}` : "missing";
	const broken = plan.reason ? ` (${plan.reason})` : "";
	const firstLine = `${marker} ${plan.title} [${plan.status}] ${position}`;
	const secondLine = [
		`id: ${plan.planId}`,
		plan.description ?? null,
		broken || null,
	]
		.filter(Boolean)
		.join(" - ");
	return `${firstLine}\n  ${secondLine}`;
}
