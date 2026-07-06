import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runElenchusCheck } from "../runtime/elenchus-engine";
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { BUNDLED_VRF_DEFAULTS_DIR, loadBundledVrfTemplates } from "./defaults";
import { syncVrfTemplatesToPlan } from "./manager";
import {
	planVrfTemplatesDir,
	projectVrfTemplatesDir,
	vrfTemplateFilePath,
	vrfTemplateImportPath,
} from "./paths";
import {
	describeRecommendedVrfTemplates,
	getRecommendedVrfTemplates,
} from "./routing";
import { VRF_TEMPLATE_NAMES, type VrfTemplateName } from "./schema";

const fs = createNodeFs();
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/**
 * Run an entry program that imports a bundled template. The resolver serves
 * the entry from memory and `templates/<name>.vrf` from the bundled dir —
 * the same shape the planner tool sees after sync.
 */
async function checkWithTemplate(input: {
	program: string;
	values?: Record<string, boolean>;
}) {
	const templates = await loadBundledVrfTemplates(fs);
	const read = (path: string): string => {
		if (path === "entry.vrf") return input.program;
		const match = /^templates\/(.+)\.vrf$/.exec(path);
		const name = match?.[1] as VrfTemplateName | undefined;
		if (name && templates[name] !== undefined) return templates[name];
		throw new Error(`not found: ${path}`);
	};
	return await runElenchusCheck({
		root: "entry.vrf",
		read,
		format: "json",
		values: input.values,
	});
}

function verdictOf(output: string): string {
	const parsed = JSON.parse(output) as { status?: string };
	return parsed.status ?? "";
}

describe("bundled vrf templates", () => {
	it("every template compiles when imported bare (no syntax errors)", async () => {
		for (const name of VRF_TEMPLATE_NAMES) {
			const run = await checkWithTemplate({
				program: [
					"DOMAIN check",
					`IMPORT "${vrfTemplateImportPath(name)}"`,
					"CHECK",
				].join("\n"),
			});
			expect(run.ok, `${name} failed to load`).toBe(true);
			if (run.ok) {
				// A verdict came back — the template parsed. (Bare import is
				// typically WARNING/CONSISTENT; a syntax error yields no status.)
				expect(verdictOf(run.output), `${name} did not parse`).not.toBe("");
			}
		}
	});

	const greenFixtures: Record<
		VrfTemplateName,
		{ facts: string[]; values: Record<string, boolean> }
	> = {
		"spec-consistency": {
			facts: [
				// One formalized requirement, fully closed (the compiler's shape),
				// and one deferred through the freedom valve.
				"FACT spec_gate.req_1 is_requirement",
				"FACT spec_gate.req_1 formalized",
				"FACT spec_gate.req_1 vrf_expressible",
				"NOT  spec_gate.req_1 rationale_recorded",
				"NOT  spec_gate.req_1 deferred_to_freedom",
				"FACT spec_gate.req_2 is_requirement",
				"NOT  spec_gate.req_2 formalized",
				"NOT  spec_gate.req_2 vrf_expressible",
				"FACT spec_gate.req_2 rationale_recorded",
			],
			values: { "spec_gate.spec_verified": true },
		},
		"plan-consistency": {
			facts: [
				"FACT plan_consistency.plan is_ready",
				"FACT plan_consistency.plan has_dependencies",
				"NOT  plan_consistency.plan touches_public_api",
			],
			values: {
				goal_approved: true,
				tasks_cover_goal: true,
				every_task_has_file: true,
				no_open_questions: true,
				deps_acyclic: true,
			},
		},
		"tdd-gate": {
			facts: [
				"FACT tdd_gate.task tdd_ready",
				"FACT tdd_gate.task tests_written_first",
				"FACT tdd_gate.task is bugfix",
				"FACT tdd_gate.task has_repro_test",
				"NOT  tdd_gate.task touches_edge_cases",
				"NOT  tdd_gate.task touches_concurrency",
			],
			values: {
				behaviors_enumerated: true,
				every_behavior_has_test: true,
				red_step_specified: true,
				tests_use_public_surface: true,
			},
		},
		"tdd-coverage": {
			facts: [
				// One branch, driven by a test that failed first and now passes.
				"FACT tdd_cov.br_1 is_branch",
				"FACT tdd_cov.br_1 had_red",
				"FACT tdd_cov.br_1 has_green",
			],
			values: { "tdd_cov.red_phase": true, "tdd_cov.suite_complete": true },
		},
		"branch-contract": {
			facts: [
				"FACT branch_contract.impl matches_contract",
				"NOT  branch_contract.impl changes_contract",
			],
			values: {
				all_branches_tested: true,
				error_paths_handled: true,
				no_dead_branch: true,
				contract_tests_green: true,
			},
		},
		"doubt-review": {
			facts: [
				"FACT doubt_review.review is_complete",
				"NOT  doubt_review.bug proven",
			],
			values: {
				risky_areas_probed: true,
				claims_cross_checked: true,
				tests_actually_run: true,
				no_unrecorded_doubt: true,
			},
		},
		"discovery-gaps": {
			facts: [
				"FACT discovery_gaps.discovery is_complete",
				"FACT discovery_gaps.project uses_external_services",
				"FACT discovery_gaps.project env_notes_written",
				"NOT  discovery_gaps.project contains_generated_code",
			],
			values: {
				entry_points_mapped: true,
				build_test_known: true,
				conventions_recorded: true,
				unknowns_written_down: true,
			},
		},
		"recovery-state": {
			facts: [
				"FACT recovery_state.repair safe_to_apply",
				"FACT recovery_state.repair is non_destructive",
				"NOT  recovery_state.planner resumes_without_repair",
			],
			values: {
				cause_identified: true,
				expected_state_read: true,
				actual_state_inspected: true,
				repair_is_minimal: true,
			},
		},
		"ship-gate": {
			facts: [
				"FACT ship_gate.plan deliverable",
				"NOT  ship_gate.plan has_schema_migration",
				"NOT  ship_gate.plan touched_public_api",
				"FACT ship_gate.plan changed_dependencies",
				"FACT ship_gate.plan lockfile_committed",
			],
			values: {
				all_tasks_merged: true,
				final_tests_green: true,
				worktree_clean: true,
				summary_written: true,
			},
		},
	};

	it("every template reaches CONSISTENT on an honest green fixture", async () => {
		for (const name of VRF_TEMPLATE_NAMES) {
			const fixture = greenFixtures[name];
			const run = await checkWithTemplate({
				program: [
					"DOMAIN check",
					`IMPORT "${vrfTemplateImportPath(name)}"`,
					...fixture.facts,
					"CHECK",
				].join("\n"),
				values: fixture.values,
			});
			expect(run.ok, `${name} failed to run`).toBe(true);
			if (run.ok) {
				expect(verdictOf(run.output), `${name} not CONSISTENT`).toBe(
					"CONSISTENT",
				);
			}
		}
	});

	it("a violated duty yields CONFLICT with the derivation chain", async () => {
		const fixture = greenFixtures["plan-consistency"];
		const run = await checkWithTemplate({
			program: [
				"DOMAIN check",
				`IMPORT "${vrfTemplateImportPath("plan-consistency")}"`,
				...fixture.facts,
				"CHECK",
			].join("\n"),
			// The dependency graph was NOT verified acyclic: the derived duty
			// `needs_order_check` clashes with the false port.
			values: { ...fixture.values, deps_acyclic: false },
		});
		expect(run.ok).toBe(true);
		if (run.ok) {
			expect(verdictOf(run.output)).toBe("CONFLICT");
			expect(run.output).toContain("order_check_gate");
		}
	});

	it("an omitted hazard keeps the check blocked (WARNING), not green", async () => {
		const run = await checkWithTemplate({
			program: [
				"DOMAIN check",
				`IMPORT "${vrfTemplateImportPath("ship-gate")}"`,
				"FACT ship_gate.plan deliverable",
				// has_schema_migration / touched_public_api / changed_dependencies
				// deliberately unstated: the duty branches must stay blocked.
				"CHECK",
			].join("\n"),
			values: {
				all_tasks_merged: true,
				final_tests_green: true,
				worktree_clean: true,
				summary_written: true,
			},
		});
		expect(run.ok).toBe(true);
		if (run.ok) {
			expect(verdictOf(run.output)).toBe("WARNING");
		}
	});
});

describe("vrf template sync", () => {
	async function createDirs() {
		const root = await mkdtemp(join(tmpdir(), "vrf-sync-"));
		tempDirs.push(root);
		const projectPaths = createProjectStoragePaths({
			agentDir: join(root, "agent"),
			projectRoot: join(root, "repo"),
		});
		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		return { projectPaths, planPaths };
	}

	it("creates, keeps unchanged, and refreshes templates", async () => {
		const { projectPaths, planPaths } = await createDirs();
		const first = await syncVrfTemplatesToPlan(fs, {
			projectPaths,
			planPaths,
		});
		expect(first).toHaveLength(VRF_TEMPLATE_NAMES.length);
		expect(first.every((r) => r.action === "created")).toBe(true);
		expect(first.every((r) => r.source === "bundled")).toBe(true);

		const second = await syncVrfTemplatesToPlan(fs, {
			projectPaths,
			planPaths,
		});
		expect(second.every((r) => r.action === "unchanged")).toBe(true);

		// A stale/hand-edited copy is healed on the next sync.
		const target = vrfTemplateFilePath(
			planVrfTemplatesDir(planPaths),
			"tdd-gate",
		);
		await fs.writeTextAtomic(target, "DOMAIN broken\n");
		const third = await syncVrfTemplatesToPlan(fs, {
			projectPaths,
			planPaths,
		});
		expect(third.find((r) => r.name === "tdd-gate")?.action).toBe("updated");
	});

	it("a project override replaces the bundled default", async () => {
		const { projectPaths, planPaths } = await createDirs();
		const overridePath = vrfTemplateFilePath(
			projectVrfTemplatesDir(projectPaths),
			"ship-gate",
		);
		const override = "DOMAIN ship_gate\nVAR custom_port\n";
		await fs.mkdirp(projectVrfTemplatesDir(projectPaths));
		await fs.writeTextAtomic(overridePath, override);

		const results = await syncVrfTemplatesToPlan(fs, {
			projectPaths,
			planPaths,
		});
		const shipGate = results.find((r) => r.name === "ship-gate");
		expect(shipGate?.source).toBe("project");
		const synced = await fs.readText(
			vrfTemplateFilePath(planVrfTemplatesDir(planPaths), "ship-gate"),
		);
		expect(synced).toBe(override);
	});

	it("bundled defaults dir contains every declared template", async () => {
		for (const name of VRF_TEMPLATE_NAMES) {
			expect(
				await fs.exists(vrfTemplateFilePath(BUNDLED_VRF_DEFAULTS_DIR, name)),
			).toBe(true);
		}
	});
});

describe("vrf template routing", () => {
	it("recommends a template at every elenchus-enabled step", () => {
		expect(
			getRecommendedVrfTemplates("discovery", "scan_project_structure"),
		).toEqual(["discovery-gaps"]);
		expect(getRecommendedVrfTemplates("planning", "consistency_check")).toEqual(
			["plan-consistency"],
		);
		expect(getRecommendedVrfTemplates("execution", "write_tdd_plan")).toEqual([
			"tdd-gate",
		]);
		expect(getRecommendedVrfTemplates("execution", "contract_check")).toEqual([
			"branch-contract",
		]);
		expect(getRecommendedVrfTemplates("finalize", "doubt_review")).toEqual([
			"doubt-review",
			"ship-gate",
		]);
		expect(getRecommendedVrfTemplates("recovery", "repair_or_resume")).toEqual([
			"recovery-state",
		]);
		expect(getRecommendedVrfTemplates("planning", "draft_plan")).toEqual([]);
	});

	it("describes recommendations with the import path", () => {
		const hint = describeRecommendedVrfTemplates(
			"planning",
			"consistency_check",
		);
		expect(hint).toContain('IMPORT "templates/plan-consistency.vrf"');
		expect(
			describeRecommendedVrfTemplates("planning", "draft_plan"),
		).toBeNull();
	});
});
