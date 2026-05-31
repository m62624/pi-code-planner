import { describe, expect, it } from "vitest";
import {
	analyzeRawGitCommand,
	checkRawGitAllowed,
	PLANNER_STATUS_TOOL_NAME,
} from "./git-watcher";

describe("raw git watcher", () => {
	it("detects raw git command segments", () => {
		expect(analyzeRawGitCommand("git status")).toBe(true);
		expect(analyzeRawGitCommand("cd app && git diff --stat")).toBe(true);
		expect(analyzeRawGitCommand("npm test; git commit -m ok")).toBe(true);
		expect(analyzeRawGitCommand("GIT_CONFIG_GLOBAL=/tmp/x git status")).toBe(
			true,
		);
		expect(analyzeRawGitCommand("command git status")).toBe(true);
	});

	it("does not match non-git words or text mentions", () => {
		expect(analyzeRawGitCommand("rg git src")).toBe(false);
		expect(analyzeRawGitCommand("echo git status")).toBe(false);
		expect(analyzeRawGitCommand("gitlab --version")).toBe(false);
		expect(analyzeRawGitCommand("node script.js")).toBe(false);
	});

	it("allows raw git when no plan is active", () => {
		expect(
			checkRawGitAllowed({
				command: "git status",
				state: { active: false, activePlanId: null },
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks raw git when plan is active and points model to planner_status", () => {
		const decision = checkRawGitAllowed({
			command: "git status",
			state: { active: true, activePlanId: "plan-a" },
		});

		expect(decision.allow).toBe(false);
		expect(decision.reason).toContain("Raw git is blocked");
		expect(decision.reason).toContain("plan-a");
		expect(decision.reason).toContain(PLANNER_STATUS_TOOL_NAME);
		expect(decision.reason).toContain("planner git wrapper tools");
	});

	it("allows non-git bash while plan is active", () => {
		expect(
			checkRawGitAllowed({
				command: "npm test",
				state: { active: true, activePlanId: "plan-a" },
			}),
		).toEqual({ allow: true, reason: null });
	});
});
