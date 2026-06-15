import { TDD_SECTIONS } from "./tdd-form";

/**
 * Shared "expected vs received" echo appended to the result of every planner
 * tool that writes a structured markdown artifact. Showing the canonical shape
 * next to what was actually saved lets the model self-correct by comparison
 * instead of guessing the format — the same teaching signal for all strict
 * tools, free-form (goal/discovery/plan/summary/questions) and structured
 * (tdd/task/refactor/doubt/contract/skill) alike.
 */
export function formatArtifactEcho(input: {
	canonicalSchema: string;
	writtenMarkdown: string;
}): string {
	return [
		"## Expected shape (canonical schema)",
		input.canonicalSchema,
		"",
		"## What you submitted (saved to disk)",
		"```markdown",
		input.writtenMarkdown.trimEnd(),
		"```",
		"",
		"Compare the two: the saved artifact should follow the canonical shape above (the same kind of sections — your prose wording is your own). If a section is missing or wrong, call the same tool again to overwrite it; otherwise continue.",
	].join("\n");
}

/**
 * Just the canonical-shape reference, for tools that already echo the content
 * they saved (goal/questions show it for user review). Avoids printing the
 * artifact twice while still giving the model the expected shape to compare.
 */
export function formatCanonicalSchemaHint(canonicalSchema: string): string {
	return [
		"## Expected shape (canonical schema)",
		canonicalSchema,
		"",
		"Make sure what you saved follows this shape; if a section is missing or wrong, call the same tool again to overwrite it.",
	].join("\n");
}

/** Canonical reference templates, keyed by the tool that produces the artifact. */
export const ARTIFACT_CANONICAL_SCHEMA: Record<string, string> = {
	planner_goal_submit: [
		"# Goal: <title>",
		"## Outcome      (what the finished work delivers)",
		"## Assumptions",
		"## Out of scope",
	].join("\n"),
	planner_questions_submit: [
		"# Discovery Questions",
		"## Status        (open questions, or 'No unresolved questions')",
		"## Assumptions   (assumptions carried into planning)",
	].join("\n"),
	planner_plan_submit: [
		"# Plan: <title>",
		"## Goal",
		"## Scope        (in-scope vs out-of-scope)",
		"## Constraints",
		"## Risks",
		"## Checks       (how each task is verified)",
		"## Tasks        (ordered task sequence)",
	].join("\n"),
	planner_discovery_submit: [
		"# Discovery: <title>",
		"## Project Overview / boundaries / findings / fundamental rules",
		"(for change requests: ## Post-Implementation Snapshot / Completed Work / Remaining Work)",
		"",
		"NOTE: Do NOT write a `## Verification Protocol` heading in body — pass",
		"the commands in the verificationProtocol argument; the wrapper renders",
		"`## Verification Protocol` with one `- <command>` per line. That section",
		"is the single source doubt_review checks against.",
	].join("\n"),
	planner_tdd_submit: [
		"# tdd.md (per active task; sections added as the lifecycle reaches them)",
		...TDD_SECTIONS.flatMap((section) => [
			`## ${section.title}`,
			...section.fields.map((field) => `- ${field}: <concrete evidence>`),
		]),
	].join("\n"),
	planner_summary_submit: [
		"# Final Summary",
		"## What changed",
		"## Verification evidence  (command → result)",
		"## Follow-ups",
	].join("\n"),
	planner_task_upsert: [
		"# Task: <title>",
		"## Acceptance Criteria",
		"## Scope        (files/areas in and out of scope)",
		"## Notes",
	].join("\n"),
	planner_refactor_review: [
		"# Refactor Review",
		"## Changed Surface / Complexity / Duplication / Naming & Boundaries / Edge Cases",
		"## Category Reviews   (per-category findings)",
		"## Decision           (applied changes, or why kept as-is)",
	].join("\n"),
	planner_doubt_review: [
		"# Doubt Review",
		"## Verification Evidence   (one entry per protocol command: command/status/evidence)",
		"## Possible Errors         (each: riskCategory/status/proofLevel/nextAction/claim/...)",
		"## Summary",
	].join("\n"),
	planner_contract_upsert: [
		"# <AGENTS.md contract block>",
		"## Purpose / Scope / Stable Contracts / Read First / Do Not Touch Unless",
		"(only the pi-code-planner:contracts block is managed; surrounding prose is yours)",
	].join("\n"),
	planner_skill_create: [
		"---",
		"name: <kebab-case>",
		"description: <one line>",
		"---",
		"# <skill title>",
		"## When to use / Steps / Notes",
	].join("\n"),
	planner_skill_update: [
		"---",
		"name: <kebab-case>",
		"description: <one line>",
		"---",
		"# <skill title>",
		"## When to use / Steps / Notes",
	].join("\n"),
};
