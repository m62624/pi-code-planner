import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "../git/runner";
import { DEFAULT_PLANNER_SETTINGS } from "../settings/schema";
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	executePlannerContractTool,
	formatPlannerContractBlock,
	formatPlannerContractsStatus,
	initialWritableContractRequired,
	parsePlannerContractMarkdown,
	upsertPlannerContractBlock,
	validateDiscoveryContractRouting,
} from "./contracts";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return [];
	}
	async branchExists(_input: GitBranchInput): Promise<boolean> {
		return true;
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

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
				domainDetails: [
					"Workflow tools enforce exits. gate → orchestrator → tools.",
				],
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
			"src/git/AGENTS.md",
			"src/guard/AGENTS.md",
			"src/instructions/AGENTS.md",
			"src/session/AGENTS.md",
			"src/worktree/AGENTS.md",
			"src/project-local/AGENTS.md",
			"instructions/AGENTS.md",
			"instructions/defaults/AGENTS.md",
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

async function setupReadyDiscoveryPlan() {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await fs.mkdirp(worktreePath);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "discovery",
		step: "scan_project_structure",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
	});
	await setActivePlan(fs, projectPaths, "plan-a");

	const contractPath = `${worktreePath}/AGENTS.md`;
	const filler = Array.from(
		{ length: 200 },
		(_, index) =>
			`- filler-detail-line-${index}: padding so the file spans multiple read chunks.`,
	).join("\n");
	await fs.writeTextAtomic(
		contractPath,
		formatPlannerContractBlock({
			path: contractPath,
			purpose: "Root contract for caching test.",
			parent: "(root)",
			childIndex: [],
			stableContracts: ["Stable."],
			readFirst: ["index.ts"],
			doNotTouchUnless: ["Do not bypass preflight."],
			domainDetails: [filler],
		}),
	);

	return { fs, git, projectPaths, worktreePath, contractPath };
}

// Reproduces the stuck route+read loop from a decoded pi-session: a small
// local model kept calling planner_contract_route on an already-fully-read
// contract, and because a completed read clears pendingRead, every re-read
// restarted the paginated dump from cursor 0 — turning a one-time read into
// an ever-repeating multi-page resend that the model never escaped.
describe("planner_contract_read caching", () => {
	it("serves a cached summary instead of re-reading an already-complete contract from cursor 0", async () => {
		const { fs, git, projectPaths, contractPath } =
			await setupReadyDiscoveryPlan();

		// Drive the paginated read to completion, exactly like the model did.
		let cursor: number | undefined;
		let complete = false;
		let iterations = 0;
		while (!complete) {
			iterations += 1;
			const result = await executePlannerContractTool({
				fs,
				git,
				projectPaths,
				toolName: "planner_contract_read",
				params: { path: contractPath, cursor },
			});
			expect(result.status).toBe("applied");
			const details = result.details as {
				nextCursor: number | null;
				complete: boolean;
			};
			complete = details.complete;
			cursor = details.nextCursor ?? undefined;
		}
		expect(iterations).toBeGreaterThan(1); // confirms the file needed multiple pages

		// Re-routing to the same contract (no explicit cursor) must not restart
		// the multi-page dump — this is exactly what the stuck session looped on.
		const cached = await executePlannerContractTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_contract_read",
			params: { path: contractPath },
		});

		expect(cached.status).toBe("applied");
		expect(cached.text).toContain("Already read in this session");
		expect((cached.details as { cached?: boolean }).cached).toBe(true);
	});

	it("still allows a real re-read when an explicit cursor is given", async () => {
		const { fs, git, projectPaths, contractPath } =
			await setupReadyDiscoveryPlan();

		let cursor: number | undefined;
		let complete = false;
		while (!complete) {
			const result = await executePlannerContractTool({
				fs,
				git,
				projectPaths,
				toolName: "planner_contract_read",
				params: { path: contractPath, cursor },
			});
			const details = result.details as {
				nextCursor: number | null;
				complete: boolean;
			};
			complete = details.complete;
			cursor = details.nextCursor ?? undefined;
		}

		const forcedReread = await executePlannerContractTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_contract_read",
			params: { path: contractPath, cursor: 0 },
		});

		expect(forcedReread.status).toBe("applied");
		expect((forcedReread.details as { cached?: boolean }).cached).toBeFalsy();
		expect(forcedReread.text).toContain("Cursor: 0");
	});
});

// Same "redo completed work from scratch" shape as the read cache bug above,
// just cheaper per call: status guidance tells the model to call
// planner_contract_scan before every broad read, and a naive re-scan after
// scanComplete walked the whole worktree again instead of recognizing there
// was nothing left to find.
describe("planner_contract_scan caching", () => {
	it("does not re-walk the worktree once scanComplete is true", async () => {
		const { fs, git, projectPaths } = await setupReadyDiscoveryPlan();

		let complete = false;
		let firstDiscoveredPaths: string[] = [];
		while (!complete) {
			const result = await executePlannerContractTool({
				fs,
				git,
				projectPaths,
				toolName: "planner_contract_scan",
				params: {},
			});
			expect(result.status).toBe("applied");
			const details = result.details as {
				complete: boolean;
				discoveredPaths: string[];
			};
			complete = details.complete;
			firstDiscoveredPaths = details.discoveredPaths;
		}

		const rescanned = await executePlannerContractTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_contract_scan",
			params: {},
		});

		expect(rescanned.status).toBe("applied");
		expect(rescanned.text).toContain("already complete");
		const details = rescanned.details as {
			cached?: boolean;
			scannedDirectories: string[];
			discoveredPaths: string[];
		};
		expect(details.cached).toBe(true);
		expect(details.scannedDirectories).toEqual([]);
		expect(details.discoveredPaths).toEqual(firstDiscoveredPaths);
	});

	it("still allows a full rescan when force: true is given", async () => {
		const { fs, git, projectPaths } = await setupReadyDiscoveryPlan();

		let complete = false;
		while (!complete) {
			const result = await executePlannerContractTool({
				fs,
				git,
				projectPaths,
				toolName: "planner_contract_scan",
				params: {},
			});
			complete = (result.details as { complete: boolean }).complete;
		}

		const forced = await executePlannerContractTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_contract_scan",
			params: { force: true },
		});

		expect(forced.status).toBe("applied");
		expect((forced.details as { cached?: boolean }).cached).toBeFalsy();
		expect(forced.text).toContain(
			"Planner contract scan complete for this batch.",
		);
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

describe("planner local contract check enforcement", () => {
	it("requires route and nearest read before finishing discovery when contracts exist", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});
		state.stage = "discovery";
		state.step = "scan_project_structure";
		state.contracts.scanComplete = true;
		state.contracts.discoveredPaths = [
			"/repo/app/AGENTS.md",
			"/repo/app/src/AGENTS.md",
		];

		expect(
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: true,
			}),
		).toContain("Call planner_contract_route");

		state.contracts.activeChains = [
			{
				targetPath: "/repo/app/src/runtime/status.ts",
				chain: ["/repo/app/AGENTS.md", "/repo/app/src/AGENTS.md"],
				reason: "discovery",
				updatedAt: 1000,
			},
		];
		expect(
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: true,
			}),
		).toContain("Call planner_contract_read");

		state.contracts.summaries = [
			{
				path: "/repo/app/AGENTS.md",
				purpose: "Root routing.",
				childIndex: [],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: [],
				updatedAt: 1000,
			},
			{
				path: "/repo/app/src/AGENTS.md",
				purpose: "Source domain.",
				childIndex: [],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: [],
				updatedAt: 1000,
			},
		];
		expect(
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: true,
			}),
		).toBeNull();
	});

	it("allows discovery to finish when the nearest contract has children but child read is the model's choice", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});
		state.stage = "discovery";
		state.step = "scan_project_structure";
		state.contracts.scanComplete = true;
		state.contracts.discoveredPaths = [
			"/repo/app/AGENTS.md",
			"/repo/app/src/AGENTS.md",
			"/repo/app/src/runtime/AGENTS.md",
		];
		state.contracts.childContracts = {
			"/repo/app/AGENTS.md": ["/repo/app/src/AGENTS.md"],
			"/repo/app/src/AGENTS.md": ["/repo/app/src/runtime/AGENTS.md"],
		};
		state.contracts.activeChains = [
			{
				targetPath: "/repo/app/src/status.ts",
				chain: ["/repo/app/AGENTS.md", "/repo/app/src/AGENTS.md"],
				reason: "discovery",
				updatedAt: 1000,
			},
		];
		state.contracts.summaries = [
			{
				path: "/repo/app/AGENTS.md",
				purpose: "Root routing.",
				childIndex: [],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: [],
				updatedAt: 1000,
			},
			{
				path: "/repo/app/src/AGENTS.md",
				purpose: "Source domain.",
				childIndex: ["src/runtime/AGENTS.md: Runtime contracts."],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: [],
				updatedAt: 1000,
			},
		];

		// Child read is now guidance-only; the model decides when to stop navigating deeper.
		expect(
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: true,
			}),
		).toBeNull();
	});

	it("allows discovery to finish when no contracts are discovered", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});
		state.contracts.scanComplete = true;
		state.contracts.discoveredPaths = [];

		expect(
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: true,
			}),
		).toBeNull();
	});

	it("requires an initial AGENTS.md contract after production source changes", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});

		const reason = initialWritableContractRequired({
			state,
			action: "no_update",
			changedFiles: ["src/vault/crypto.ts", "src/vault/crypto.test.ts"],
			evidence: ["No AGENTS.md files exist in the project yet."],
		});

		expect(reason).toContain(
			"Cannot record planner_contract_check as no_update",
		);
		expect(reason).toContain("src/vault/crypto.ts");
		expect(reason).toContain("action=create_new");
	});

	it("allows no_update when a writable AGENTS.md contract is already known", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});
		state.contracts.discoveredPaths = ["/repo/app/AGENTS.md"];

		expect(
			initialWritableContractRequired({
				state,
				action: "no_update",
				changedFiles: ["src/vault/crypto.ts"],
				evidence: ["Existing AGENTS.md contract does not need changes."],
			}),
		).toBeNull();
	});

	it("requires an initial contract for tests-only project changes too", () => {
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/a",
			worktreePath: "/repo/app",
		});

		const reason = initialWritableContractRequired({
			state,
			action: "no_update",
			changedFiles: ["src/vault/crypto.test.ts"],
			evidence: ["Only tests changed."],
		});

		expect(reason).toContain("src/vault/crypto.test.ts");
	});
});
