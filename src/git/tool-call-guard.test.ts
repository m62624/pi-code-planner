import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { GitSettings } from "../settings/schema";
import { analyzeGitToolCall, isShellToolCall } from "./tool-call-guard";

const settings: GitSettings = DEFAULT_SETTINGS.git;

describe("isShellToolCall", () => {
	it("returns true for configured shell tools", () => {
		expect(isShellToolCall("bash", settings)).toBe(true);
	});

	it("returns false for non-shell tools", () => {
		expect(isShellToolCall("edit", settings)).toBe(false);
	});
});

describe("analyzeGitToolCall", () => {
	it("does not block anything when no plan is active", () => {
		const result = analyzeGitToolCall({
			activePlan: false,
			toolName: "bash",
			input: { command: "git commit -m test" },
			settings,
		});

		expect(result.blocked).toBe(false);
	});

	it("blocks direct git commit from shell tools when a plan is active", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "bash",
			input: { command: "git commit -m test" },
			settings,
		});

		expect(result).toMatchObject({
			blocked: true,
			kind: "direct_commit",
			pattern: "\\bgit\\s+commit\\b",
		});
	});

	it("blocks configured commit aliases", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "bash",
			input: { command: "gcam test" },
			settings: {
				...settings,
				blockedCommitPatterns: [
					...settings.blockedCommitPatterns,
					"\\bgcam\\b",
				],
			},
		});

		expect(result).toMatchObject({
			blocked: true,
			kind: "direct_commit",
			pattern: "\\bgcam\\b",
		});
	});

	it("blocks dangerous git operations", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "bash",
			input: { command: "git reset --hard HEAD~1" },
			settings,
		});

		expect(result).toMatchObject({
			blocked: true,
			kind: "dangerous_git_operation",
			pattern: "\\bgit\\s+reset\\b",
		});
	});

	it("allows read-only git commands", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "bash",
			input: { command: "git status --short" },
			settings,
		});

		expect(result.blocked).toBe(false);
	});

	it("does not block edit tools that contain git commit text", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "edit",
			input: { path: "README.md", content: "Run git commit -m test" },
			settings,
		});

		expect(result.blocked).toBe(false);
	});

	it("does not block unknown non-shell tools", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "custom_tool",
			input: { command: "git commit -m test" },
			settings,
		});

		expect(result.blocked).toBe(false);
	});

	it("blocks custom shell tools configured in settings", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "shell",
			input: { command: "git commit -m test" },
			settings: {
				...settings,
				shellToolNames: ["bash", "shell"],
			},
		});

		expect(result).toMatchObject({
			blocked: true,
			kind: "direct_commit",
		});
	});

	it("does not block shell calls without a command string", () => {
		const result = analyzeGitToolCall({
			activePlan: true,
			toolName: "bash",
			input: { command: 123 },
			settings,
		});

		expect(result.blocked).toBe(false);
	});
});
