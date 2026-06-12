import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLANNER_SETTINGS } from "../settings/schema";
import { createNodeFs } from "../storage/fs";
import { createInitialPlanState } from "../storage/schema";
import {
	formatPlannerContractBlock,
	formatPlannerContractsStatus,
	parsePlannerContractMarkdown,
	upsertPlannerContractBlock,
} from "./contracts";

describe("planner local contracts parser", () => {
	const root = "/repo/app";
	const path = "/repo/app/src/AGENTS.md";

	it("parses a valid managed AGENTS block", () => {
		const result = parsePlannerContractMarkdown(
			formatPlannerContractBlock({
				path,
				purpose: "Owns runtime gates.",
				parent: "../AGENTS.md",
				childIndex: [
					{ path: "state/AGENTS.md", description: "State contracts." },
				],
				stableContracts: ["planner_status is source of truth."],
				readFirst: ["state-machine.ts"],
				doNotTouchUnless: ["Do not bypass preflight."],
				domainDetails: ["Workflow tools enforce exits."],
			}),
			path,
			root,
		);

		expect(result.contract).toMatchObject({
			purpose: "Owns runtime gates.",
			parent: "../AGENTS.md",
			stableContracts: ["planner_status is source of truth."],
		});
		expect(result.diagnostics).toEqual([]);
	});

	it("reads existing files without managed blocks as guidance with diagnostics", () => {
		const result = parsePlannerContractMarkdown(
			"# Existing guidance\n\nRead src first.\n",
			"/repo/app/AGENTS.md",
			root,
		);

		expect(result.hasManagedBlock).toBe(false);
		expect(result.contract).toBeNull();
		expect(result.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "missing_managed_block",
		});
		expect(result.diagnostics[0]?.message).toContain("Writable AGENTS.md");
		expect(result.diagnostics[0]?.message).toContain("planner_contract_upsert");
	});

	it("reads non-AGENTS context files as read-only imports", () => {
		const result = parsePlannerContractMarkdown(
			"# Gemini guidance\n\nPrefer focused tests.\n",
			"/repo/app/GEMINI.md",
			root,
		);

		expect(result.hasManagedBlock).toBe(false);
		expect(result.contract).toBeNull();
		expect(result.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "missing_managed_block",
		});
		expect(result.diagnostics[0]?.message).toContain(
			"Read-only context import",
		);
		expect(result.diagnostics[0]?.message).toContain("nearest AGENTS.md");
	});

	it("rejects unknown and duplicate managed headings", () => {
		const markdown = [
			"<!-- pi-code-planner:contracts:start -->",
			"## Planner Contracts",
			"### Purpose",
			"Runtime.",
			"### Purpose",
			"Duplicate.",
			"### Unknown",
			"- bad",
			"<!-- pi-code-planner:contracts:end -->",
		].join("\n");

		const result = parsePlannerContractMarkdown(markdown, path, root);

		expect(result.diagnostics.map((item) => item.code)).toContain(
			"duplicate_heading",
		);
		expect(result.diagnostics.map((item) => item.code)).toContain(
			"unknown_heading",
		);
		expect(result.diagnostics.map((item) => item.message).join("\n")).toContain(
			"Allowed headings",
		);
	});

	it("validates parent backlinks and child index scope", () => {
		const result = parsePlannerContractMarkdown(
			formatPlannerContractBlock({
				path,
				purpose: "Runtime.",
				parent: "../../outside/AGENTS.md",
				childIndex: [
					{ path: "../AGENTS.md", description: "Not a child." },
					{ path: "AGENTS.md", description: "Self." },
				],
				stableContracts: ["Stable."],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
			}),
			path,
			root,
		);

		expect(result.diagnostics.map((item) => item.code)).toEqual(
			expect.arrayContaining([
				"parent_outside_root",
				"child_not_descendant",
				"child_self_reference",
			]),
		);
	});

	it("preserves non-planner content and appends a newline at EOF", () => {
		const existing = "# User Notes\r\n\r\nKeep this.\r\n";
		const next = upsertPlannerContractBlock({
			existingContent: existing,
			root,
			contract: {
				path: "/repo/app/AGENTS.md",
				purpose: "Root router.",
				parent: null,
				childIndex: [],
				stableContracts: ["Use planner_status."],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
			},
		});

		expect(next).toContain("# User Notes\n\nKeep this.");
		expect(next).toContain("<!-- pi-code-planner:contracts:start -->");
		expect(next.endsWith("\n")).toBe(true);
	});

	it("updates an existing managed block idempotently", () => {
		const first = upsertPlannerContractBlock({
			existingContent: "",
			root,
			contract: {
				path: "/repo/app/AGENTS.md",
				purpose: "Root router.",
				parent: null,
				childIndex: [],
				stableContracts: ["Use planner_status."],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
			},
		});
		const second = upsertPlannerContractBlock({
			existingContent: first,
			root,
			contract: {
				path: "/repo/app/AGENTS.md",
				purpose: "Root router.",
				parent: null,
				childIndex: [],
				stableContracts: ["Use planner_status."],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
			},
		});

		expect(second).toBe(first);
	});

	it("parses repository AGENTS.md files without schema errors", async () => {
		const fs = createNodeFs();
		const repoRoot = process.cwd();
		const paths = [
			"AGENTS.md",
			"src/AGENTS.md",
			"src/runtime/AGENTS.md",
			"src/settings/AGENTS.md",
			"src/storage/AGENTS.md",
			"instructions/AGENTS.md",
			".github/AGENTS.md",
		].map((path) => join(repoRoot, path));

		for (const contractPath of paths) {
			const result = parsePlannerContractMarkdown(
				await fs.readText(contractPath),
				contractPath,
				repoRoot,
			);

			expect(
				result.diagnostics.filter((item) => item.severity === "error"),
				contractPath,
			).toEqual([]);
		}
	});
});

describe("planner local contract status", () => {
	it("uses stored summaries and does not require file reads", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});
		state.contracts.activeChains = [
			{
				targetPath: "/repo/app/src/runtime/index.ts",
				chain: ["/repo/app/AGENTS.md", "/repo/app/src/AGENTS.md"],
				reason: "test",
				updatedAt: 1,
			},
		];
		state.contracts.summaries = [
			{
				path: "/repo/app/AGENTS.md",
				purpose: "Root routes domains.",
				childIndex: ["src/AGENTS.md: Source contracts"],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: [],
				updatedAt: 1,
			},
		];

		const lines = formatPlannerContractsStatus({
			state,
			settings: DEFAULT_PLANNER_SETTINGS.contracts,
		});

		expect(lines.join("\n")).toContain("Root routes domains.");
		expect(lines.join("\n")).toContain(
			"/repo/app/src/AGENTS.md (summary not loaded; call planner_contract_read)",
		);
	});
});
