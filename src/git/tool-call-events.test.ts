import type {
	ToolCallEvent,
	UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GitCore } from "./core";
import { checkPlannerToolCall, checkPlannerUserBash } from "./tool-call-events";

function core(activePlan: boolean): GitCore {
	return {
		state: {
			isActive: () => activePlan,
		},
		settings: {
			settings: {
				git: {
					shellToolNames: ["bash", "shell"],
					blockedCommitPatterns: ["\\bgit\\s+commit\\b", "\\bgcam\\b"],
					blockedDangerousPatterns: ["\\bgit\\s+reset\\b"],
				},
			},
		},
	} as GitCore;
}

function toolCall(
	toolName: string,
	input: Record<string, unknown>,
): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input,
	} as ToolCallEvent;
}

function userBash(command: string): UserBashEvent {
	return {
		type: "user_bash",
		command,
		excludeFromContext: false,
		cwd: "/repo",
	};
}

describe("checkPlannerToolCall", () => {
	it("blocks shell git commits while planner is active", () => {
		const result = checkPlannerToolCall(
			core(true),
			toolCall("bash", { command: "git commit -m test" }),
		);

		expect(result).toMatchObject({
			block: true,
		});
		expect(result?.reason).toContain("Direct git commit is forbidden");
		expect(result?.reason).toContain("git commit -m test");
	});

	it("blocks configured shell aliases while planner is active", () => {
		const result = checkPlannerToolCall(
			core(true),
			toolCall("shell", { command: "gcam test" }),
		);

		expect(result).toMatchObject({
			block: true,
		});
		expect(result?.reason).toContain("\\bgcam\\b");
	});

	it("allows read-only git commands", () => {
		const result = checkPlannerToolCall(
			core(true),
			toolCall("bash", { command: "git status --short" }),
		);

		expect(result).toBeUndefined();
	});

	it("allows git text in non-shell tools", () => {
		const result = checkPlannerToolCall(
			core(true),
			toolCall("write", { path: "README.md", content: "git commit" }),
		);

		expect(result).toBeUndefined();
	});

	it("allows direct git when planner is inactive", () => {
		const result = checkPlannerToolCall(
			core(false),
			toolCall("bash", { command: "git reset --hard HEAD" }),
		);

		expect(result).toBeUndefined();
	});
});

describe("checkPlannerUserBash", () => {
	it("returns a handled failing bash result for blocked user bash", () => {
		const result = checkPlannerUserBash(
			core(true),
			userBash("git reset --hard HEAD"),
		);

		expect(result?.result).toMatchObject({
			exitCode: 1,
			cancelled: false,
			truncated: false,
		});
		expect(result?.result?.output).toContain("This git operation is managed");
	});

	it("allows user bash when planner is inactive", () => {
		const result = checkPlannerUserBash(
			core(false),
			userBash("git commit -m test"),
		);

		expect(result).toBeUndefined();
	});
});
