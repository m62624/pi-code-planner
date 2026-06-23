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
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerDoubtTool } from "./doubt-tools";

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

describe("planner doubt review tool", () => {
	it("writes a structured doubt review", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "One suspected issue was disproven by code inspection.",
				verificationEvidence: passedVerificationEvidence(),
				possibleErrors: [
					{
						id: "resume-selection-bug",
						riskCategory: "user_flow_regression",
						status: "disproven",
						proofLevel: "disproven_by_code",
						claim: "Resume selection compares labels instead of ids.",
						specReference: "goal.md resume command requirements",
						codePath: "src/commands/resume.ts",
						verification:
							"Inspected selection adapter and confirmed it returns vaultChatId.",
						evidence: ["Selected option value is vaultChatId, not label text."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("applied");
		expect(setup.fs.snapshot()[setup.planPaths.verifyMd]).toContain(
			"## Possible Errors",
		);
		expect(setup.fs.snapshot()[setup.planPaths.verifyMd]).toContain(
			"- riskCategory: user_flow_regression",
		);
		expect(result.text).toContain("Proven bugs: 0");
	});

	it("blocks proven bugs without proof", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A suspected issue was not proven.",
				verificationEvidence: passedVerificationEvidence(),
				possibleErrors: [
					{
						id: "storage-root-bug",
						riskCategory: "persistence_error",
						status: "proven_bug",
						proofLevel: "insufficient_evidence",
						claim: "Storage root is wrong.",
						specReference: "spec storage root",
						codePath: "src/index.ts",
						verification: "Only suspected from reading names.",
						evidence: ["Path looked suspicious."],
						counterEvidence: [],
						nextAction: "create_revision_task",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("not proof");
	});

	it("requires a valid risk category", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A suspected issue used an invalid risk category.",
				verificationEvidence: passedVerificationEvidence(),
				possibleErrors: [
					{
						id: "unknown-risk",
						riskCategory: "maybe_bad",
						status: "needs_probe",
						proofLevel: "insufficient_evidence",
						claim: "Something might be wrong.",
						specReference: "goal.md",
						codePath: "src/index.ts",
						verification: "No probe yet.",
						evidence: ["Only a suspicion."],
						counterEvidence: [],
						nextAction: "run_probe",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("riskCategory");
	});

	it("blocks closing placeholder or superficial findings as not_a_bug", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A placeholder concern was dismissed without proof.",
				verificationEvidence: passedVerificationEvidence(),
				possibleErrors: [
					{
						id: "placeholder-implementation",
						riskCategory: "requirement_mismatch",
						status: "not_a_bug",
						proofLevel: "code_path_proven",
						claim:
							"Implementation may still be a placeholder for the actual vault behavior.",
						specReference: "goal.md accepted behavior",
						codePath: "src/vault/index.ts",
						verification: "Only checked that files exist.",
						evidence: ["Placeholder-looking logic remains."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("must be proven_bug or needs_probe");
	});

	it("requires evidence for every discovery verification command", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "Only one check was recorded.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
				],
				possibleErrors: [
					{
						id: "missing-build-evidence",
						riskCategory: "missing_test",
						status: "needs_probe",
						proofLevel: "insufficient_evidence",
						claim: "Build evidence may be missing.",
						specReference: "discovery.md Verification Protocol",
						codePath: "package.json",
						verification: "Need to run the build check.",
						evidence: ["Build command was not represented in evidence."],
						counterEvidence: [],
						nextAction: "run_probe",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("npm run build");
	});

	it("requires failed verification commands to become findings", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "The build failed but was not tied to a finding.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
					{
						command: "npm run build",
						status: "failed",
						evidence: "TypeScript failed.",
					},
				],
				possibleErrors: [
					{
						id: "unrelated-risk",
						riskCategory: "integration_break",
						status: "disproven",
						proofLevel: "disproven_by_code",
						claim: "Resume routing might be broken.",
						specReference: "goal.md",
						codePath: "src/runtime/status.ts",
						verification: "Inspected routing table.",
						evidence: ["Routing table still has the expected entry."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("Required protocol command(s) did not pass");
	});

	it("reports field-level and protocol-level violations together in one rejection", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "Multiple problems exist in this review at once.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
					{
						command: "npm run build",
						status: "failed",
						evidence: "TypeScript failed.",
					},
				],
				possibleErrors: [
					{
						// Wrong tuple: disproven must use a disproven_* proofLevel.
						id: "wrong-tuple-finding",
						riskCategory: "user_flow_regression",
						status: "disproven",
						proofLevel: "insufficient_evidence",
						claim: "Resume routing might be broken.",
						specReference: "goal.md",
						codePath: "src/runtime/status.ts",
						verification: "Inspected routing table.",
						evidence: ["Routing table still has the expected entry."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		// Both independent problems surface in the same response.
		expect(result.text).toContain(
			"disproven but proofLevel must be disproven_by_test",
		);
		expect(result.text).toContain("Required protocol command(s) did not pass");
		// The stack-agnostic finding-shape cheat-sheet is always appended.
		expect(result.text).toContain("Valid finding shapes");
		expect(result.text).toContain(
			"needs_probe  -> insufficient_evidence -> run_probe",
		);
	});

	it("appends the finding-shape cheat-sheet to parse-level rejections too", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "Invalid risk category should still teach the grammar.",
				verificationEvidence: passedVerificationEvidence(),
				possibleErrors: [
					{
						id: "bad-category",
						riskCategory: "not_a_real_category",
						status: "needs_probe",
						proofLevel: "insufficient_evidence",
						claim: "Something might be wrong.",
						specReference: "goal.md",
						codePath: "src/index.ts",
						verification: "No probe yet.",
						evidence: ["Only a suspicion."],
						counterEvidence: [],
						nextAction: "run_probe",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("riskCategory");
		expect(result.text).toContain("Valid finding shapes");
	});

	it("allows failed verification commands only when a finding covers them", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "The build failure is proven and must return to planning.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
					{
						command: "npm run build",
						status: "failed",
						evidence: "TypeScript failed on src/runtime/contracts.ts.",
					},
				],
				possibleErrors: [
					{
						id: "build-command-fails",
						riskCategory: "integration_break",
						status: "proven_bug",
						proofLevel: "reproduced_command",
						claim: "npm run build fails after the planner changes.",
						specReference: "discovery.md Verification Protocol",
						codePath: "src/runtime/contracts.ts",
						verification: "Ran npm run build and reproduced the failure.",
						evidence: ["npm run build reports a TypeScript error."],
						counterEvidence: [],
						nextAction: "create_revision_task",
					},
				],
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Proven bugs: 1");
	});

	it("lets a not_run protocol command be closed terminally as not_a_bug", async () => {
		const setup = await createDoubtSetup();

		// The command cannot run in this environment, so it can never be a
		// proven_bug (un-reproducible) and a needs_probe would block the exit
		// forever. A not_a_bug finding with evidence is the terminal resolution.
		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "Build cannot run locally; it is covered in CI.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
					{
						command: "npm run build",
						status: "not_run",
						evidence: "Toolchain not installed locally.",
					},
				],
				possibleErrors: [
					{
						id: "build-not-runnable-here",
						riskCategory: "integration_break",
						status: "not_a_bug",
						proofLevel: "insufficient_evidence",
						claim: "npm run build cannot be run in this environment.",
						specReference: "discovery.md Verification Protocol",
						codePath: "package.json",
						verification:
							"Confirmed the CI workflow runs npm run build on every push.",
						evidence: [
							"npm run build executes in .github/workflows/ci.yml build job.",
						],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Needs probe: 0");
	});

	it("still rejects a failed command closed as not_a_bug", async () => {
		const setup = await createDoubtSetup();

		// A command that actually failed when run is a real local failure and may
		// never be waved away as not_a_bug — only proven_bug/needs_probe cover it.
		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "Build failed but the finding tries to dismiss it.",
				verificationEvidence: [
					{
						command: "npm test",
						status: "passed",
						evidence: "Unit tests passed.",
					},
					{
						command: "npm run build",
						status: "failed",
						evidence: "TypeScript failed.",
					},
				],
				possibleErrors: [
					{
						id: "build-failure-dismissed",
						riskCategory: "integration_break",
						status: "not_a_bug",
						proofLevel: "insufficient_evidence",
						claim: "npm run build failure is not important.",
						specReference: "discovery.md Verification Protocol",
						codePath: "src/runtime/contracts.ts",
						verification: "Looked at the error and decided to ignore it.",
						evidence: ["The failure seems unrelated."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("Required protocol command(s) did not pass");
	});
});

function passedVerificationEvidence() {
	return [
		{
			command: "npm test",
			status: "passed",
			evidence: "Unit tests passed.",
		},
		{
			command: "npm run build",
			status: "passed",
			evidence: "Build passed.",
		},
	];
}

async function createDoubtSetup() {
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
		stage: "finalize",
		step: "doubt_review",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	await fs.writeTextAtomic(
		planPaths.discoveryMd,
		[
			"# Discovery",
			"",
			"## Verification Protocol",
			"- test: npm test",
			"- build: npm run build",
			"",
		].join("\n"),
	);
	return { fs, git, projectPaths, planPaths };
}
