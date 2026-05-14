import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import {
	renderBranchNames,
	validateBranchNamingSettings,
} from "./branch-naming";

describe("branch naming", () => {
	it("renders default branch names", () => {
		const names = renderBranchNames(DEFAULT_SETTINGS.git.branchNaming, {
			planId: "Auth Refactor",
			workItemId: "Parse Token",
			attemptId: "Try A",
		});

		expect(names).toEqual({
			plan: "planner/auth-refactor/main",
			child: "planner/auth-refactor/work/parse-token",
			experiment: "planner/auth-refactor/experiment/parse-token/try-a",
		});
	});

	it("accepts the default settings", () => {
		expect(() =>
			validateBranchNamingSettings(DEFAULT_SETTINGS.git.branchNaming),
		).not.toThrow();
	});

	it("rejects missing required placeholders", () => {
		expect(() =>
			validateBranchNamingSettings({
				plan: "planner/main",
				child: "planner/{planId}/work/{workItemId}",
				experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
			}),
		).toThrow("Branch naming template plan missing {planId}");
	});

	it("rejects ref prefix conflicts", () => {
		expect(() =>
			validateBranchNamingSettings({
				plan: "planner/{planId}",
				child: "planner/{planId}/work/{workItemId}",
				experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
			}),
		).toThrow(
			"Branch naming conflict: plan (planner/plan) is a prefix of child (planner/plan/work/work)",
		);
	});

	it("rejects invalid rendered branch names", () => {
		expect(() =>
			validateBranchNamingSettings({
				plan: "planner/{planId}/main.lock",
				child: "planner/{planId}/work/{workItemId}",
				experiment: "planner/{planId}/experiment/{workItemId}/{attemptId}",
			}),
		).toThrow("Invalid branch name: planner/plan/main.lock");
	});

	it("requires values used by templates", () => {
		expect(() =>
			renderBranchNames(DEFAULT_SETTINGS.git.branchNaming, {
				planId: "plan",
			}),
		).toThrow("Missing branch naming value: workItemId");
	});
});
