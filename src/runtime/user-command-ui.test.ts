import { describe, expect, it } from "vitest";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	confirmPlannerDelete,
	inputPlannerRenameTitle,
	type PlannerCommandUi,
	planOptionLabel,
	selectPlannerPlanId,
	selectPlannerPlanIdFromList,
} from "./user-command-ui";
import type { PlannerListEntry } from "./user-commands";

class MockUi implements PlannerCommandUi {
	selected?: string;
	confirmed = false;
	inputText?: string;
	readonly selectCalls: Array<{ title: string; options: string[] }> = [];
	readonly confirmCalls: Array<{
		title: string;
		message: string;
		opts?: { timeout?: number };
	}> = [];
	readonly inputCalls: Array<{ title: string; placeholder?: string }> = [];
	readonly notifications: Array<{ message: string; type?: string }> = [];

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		return this.selected;
	}

	async confirm(
		title: string,
		message: string,
		opts?: { timeout?: number },
	): Promise<boolean> {
		this.confirmCalls.push({ title, message, opts });
		return this.confirmed;
	}

	async input(
		title: string,
		placeholder?: string,
	): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		return this.inputText;
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, type });
	}
}

function plan(
	input: Partial<PlannerListEntry> & { planId: string },
): PlannerListEntry {
	return {
		planId: input.planId,
		title: input.title ?? input.planId,
		status: input.status ?? "active",
		active: input.active ?? false,
		stage: input.stage ?? "discovery",
		step: input.step ?? "scan_project_structure",
		worktreePath: input.worktreePath ?? `/worktrees/${input.planId}`,
		broken: input.broken ?? false,
		reason: input.reason ?? null,
	};
}

describe("planner user command UI helpers", () => {
	it("formats plan options with active marker and stage", () => {
		expect(
			planOptionLabel(
				plan({
					planId: "plan-a",
					title: "Plan A",
					active: true,
					stage: "execution",
					step: "write_tests",
				}),
			),
		).toBe("* plan-a [active] execution/write_tests - Plan A");
	});

	it("selects plan id by the selected TUI label", async () => {
		const ui = new MockUi();
		const plans = [plan({ planId: "plan-a" }), plan({ planId: "plan-b" })];
		ui.selected = planOptionLabel(plans[1]);

		await expect(
			selectPlannerPlanIdFromList({
				ui,
				plans,
				title: "Switch planner plan",
			}),
		).resolves.toBe("plan-b");
		expect(ui.selectCalls[0]?.options).toHaveLength(2);
	});

	it("notifies when no plans exist", async () => {
		const ui = new MockUi();

		await expect(
			selectPlannerPlanIdFromList({
				ui,
				plans: [],
				title: "Switch planner plan",
			}),
		).resolves.toBeNull();
		expect(ui.notifications).toEqual([
			{ message: "No planner plans in this project.", type: "warning" },
		]);
	});

	it("does not throw when project storage does not exist yet", async () => {
		const ui = new MockUi();

		await expect(
			selectPlannerPlanId({
				ui,
				fs: new MockPlannerFs(),
				projectPaths: createProjectStoragePaths({
					agentDir: "/agent",
					projectRoot: "/repo/app",
				}),
				title: "Switch planner plan",
			}),
		).resolves.toBeNull();
		expect(ui.selectCalls).toEqual([]);
		expect(ui.notifications).toEqual([
			{ message: "No planner plans in this project.", type: "warning" },
		]);
	});

	it("uses timed confirmation for active delete", async () => {
		const ui = new MockUi();
		ui.confirmed = true;

		await expect(
			confirmPlannerDelete({ ui, planId: "plan-a", active: true }),
		).resolves.toBe(true);
		expect(ui.confirmCalls[0]).toMatchObject({
			title: "Delete active planner plan?",
			opts: { timeout: 10_000 },
		});
	});

	it("uses normal confirmation for inactive delete", async () => {
		const ui = new MockUi();

		await confirmPlannerDelete({ ui, planId: "plan-a", active: false });
		expect(ui.confirmCalls[0]).toMatchObject({
			title: "Delete planner plan?",
			opts: undefined,
		});
	});

	it("trims rename input and reports cancellation on empty input", async () => {
		const ui = new MockUi();
		ui.inputText = "  New Title  ";

		await expect(inputPlannerRenameTitle({ ui })).resolves.toBe("New Title");

		const cancelled = new MockUi();
		cancelled.inputText = " ";
		await expect(
			inputPlannerRenameTitle({ ui: cancelled }),
		).resolves.toBeNull();
		expect(cancelled.notifications[0]).toMatchObject({
			message: "Planner rename cancelled.",
		});
	});
});
