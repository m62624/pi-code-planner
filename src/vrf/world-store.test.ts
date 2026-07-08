import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { sha256 } from "../hash";
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	type PlanStoragePaths,
} from "../storage/paths";
import type { SpecRecord } from "../storage/spec-store";
import { MockPlannerFs } from "../test/mock-fs";
import { syncVrfTemplatesToPlan } from "./manager";
import {
	assertWorldStatements,
	collectAnchorPaths,
	compileWorld,
	readWorldRecord,
	readWorldRunRecord,
	retractWorldStatements,
	runWorldCheck,
	sweepWorldAnchors,
	WORLD_ENTRY_NAME,
	type WorldRecord,
	type WorldStatement,
	type WorldStatementInput,
} from "./world-store";

const ORIGIN = { stage: "discovery", step: "scan_project_structure" };

function mockPlanPaths(): PlanStoragePaths {
	return createPlanStoragePaths(
		createProjectStoragePaths({ agentDir: "/agent", projectRoot: "/repo/app" }),
		"plan-w",
	);
}

function statement(
	lines: string[],
	overrides: Partial<WorldStatementInput> = {},
): WorldStatementInput {
	return { lines, domain: "discovery", origin: ORIGIN, ...overrides };
}

describe("world registry", () => {
	it("assigns sequential ids, infers kinds, and persists", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		const added = await assertWorldStatements(fs, planPaths, [
			statement(["FACT cache is_lru"]),
			statement(["KNOWS planner repo uses_vitest"]),
			statement([
				"PREMISE only_one:",
				"    EXCLUSIVE",
				"    db is_postgres",
				"    db is_sqlite",
			]),
			statement(["TOTAL covered_by ON requirements"], { domain: "plan" }),
		]);
		expect(added.map((s) => s.id)).toEqual(["w1", "w2", "w3", "w4"]);
		expect(added.map((s) => s.kind)).toEqual([
			"fact",
			"believes",
			"premise",
			"premise",
		]);
		const record = await readWorldRecord(fs, planPaths);
		expect(record.nextId).toBe(5);
		expect(record.statements).toHaveLength(4);
	});

	it("does not lose statements when asserts race (the plan.json lost-update class)", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await Promise.all(
			["a", "b", "c", "d", "e"].map((atom) =>
				assertWorldStatements(fs, planPaths, [
					statement([`FACT subject_${atom} observed`]),
				]),
			),
		);
		const record = await readWorldRecord(fs, planPaths);
		expect(record.statements).toHaveLength(5);
		expect(new Set(record.statements.map((s) => s.id)).size).toBe(5);
	});

	it("rejects instrument keywords and points at the reason modes", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["PROVE merge is_blocked"]),
			]),
		).rejects.toThrow(/instrument.*reason/s);
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["FACT a b", "TRY hotfix is_needed"]),
			]),
		).rejects.toThrow(/instrument/);
	});

	it("rejects compiler-owned lines and unknown keywords", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(['IMPORT "../../outside.vrf"']),
			]),
		).rejects.toThrow(/owned by the world compiler/);
		await expect(
			assertWorldStatements(fs, planPaths, [statement(["FROB cache"])]),
		).rejects.toThrow(/must start with one of/);
	});

	it("rejects invalid domains and anchors on non-observations", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["FACT a b"], { domain: "main" }),
			]),
		).rejects.toThrow(/not valid/);
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["FACT a b"], { domain: "../evil" }),
			]),
		).rejects.toThrow(/not valid/);
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["RULE r1:", "    WHEN a b", "    THEN c d"], {
					anchor: { path: "src/x.ts", hash: "h" },
				}),
			]),
		).rejects.toThrow(/only FACT\/NOT/);
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["FACT a b"], {
					anchor: { path: "../outside.ts", hash: "h" },
				}),
			]),
		).rejects.toThrow(/project-root-relative/);
	});

	it("a failed batch writes nothing (all-or-nothing)", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await expect(
			assertWorldStatements(fs, planPaths, [
				statement(["FACT good statement"]),
				statement(["CHECK"]),
			]),
		).rejects.toThrow();
		const record = await readWorldRecord(fs, planPaths);
		expect(record.statements).toHaveLength(0);
	});

	it("retract removes by id, names unknown ids, and never throws", async () => {
		const fs = new MockPlannerFs();
		const planPaths = mockPlanPaths();
		await assertWorldStatements(fs, planPaths, [
			statement(["FACT a b"]),
			statement(["FACT c d"]),
		]);
		const result = await retractWorldStatements(fs, planPaths, ["w1", "w99"]);
		expect(result.removed).toEqual(["w1"]);
		expect(result.missing).toEqual(["w99"]);
		const record = await readWorldRecord(fs, planPaths);
		expect(record.statements.map((s) => s.id)).toEqual(["w2"]);
	});
});

describe("anchor sweep", () => {
	const record: WorldRecord = {
		version: 1,
		nextId: 4,
		statements: [
			world("w1", ["FACT cache is_lru"], {
				anchor: { path: "src/cache.ts", hash: "aaa" },
			}),
			world("w2", ["NOT  logger is_verbose"], {
				anchor: { path: "src/log.ts", hash: "bbb" },
			}),
			world("w3", ["FACT repo uses_vitest"]),
		],
	};

	it("collects sorted unique anchor paths", () => {
		expect(collectAnchorPaths(record)).toEqual(["src/cache.ts", "src/log.ts"]);
	});

	it("flags changed and deleted files; unsampled paths stay fresh", () => {
		const stale = sweepWorldAnchors(
			record,
			new Map([
				["src/cache.ts", "CHANGED"],
				["src/log.ts", null],
			]),
		);
		expect(stale).toEqual([
			{ statementId: "w1", path: "src/cache.ts" },
			{ statementId: "w2", path: "src/log.ts" },
		]);
		expect(
			sweepWorldAnchors(record, new Map([["src/cache.ts", "aaa"]])),
		).toEqual([]);
		expect(sweepWorldAnchors(record, new Map())).toEqual([]);
	});
});

describe("world compiler", () => {
	it("is deterministic and independent of registry order", () => {
		const a: WorldRecord = {
			version: 1,
			nextId: 4,
			statements: [
				world("w1", ["FACT cache is_lru"]),
				world("w2", ["FACT task_1 is_planned"], { domain: "plan" }),
				world("w3", ["ASSUME task_1 is_easy"], { domain: "scratch" }),
			],
		};
		const b: WorldRecord = {
			...a,
			statements: [...a.statements].reverse(),
		};
		const first = compileWorld(a);
		const second = compileWorld(b);
		expect([...first.files.entries()]).toEqual([...second.files.entries()]);
		expect(first.worldHash).toBe(second.worldHash);
	});

	it("sorts statement ids numerically (w10 after w9)", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 11,
			statements: [
				world("w10", ["FACT later statement"]),
				world("w9", ["FACT earlier statement"]),
			],
		};
		const compiled = compileWorld(record);
		const discovery = compiled.files.get("world/discovery.vrf") ?? "";
		expect(discovery.indexOf("earlier")).toBeLessThan(
			discovery.indexOf("later"),
		);
	});

	it("layers imports acyclically: discovery < plan < task_* < scratch", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 5,
			statements: [
				world("w1", ["FACT cache is_lru"]),
				world("w2", ["FACT task_a is_planned"], { domain: "plan" }),
				world("w3", ["FACT step_1 done"], { domain: "task_alpha" }),
				world("w4", ["ASSUME all is_well"], { domain: "scratch" }),
			],
		};
		const compiled = compileWorld(record);
		expect(compiled.domains).toEqual([
			"discovery",
			"plan",
			"task_alpha",
			"scratch",
		]);
		expect(compiled.files.get("world/discovery.vrf")).not.toContain("IMPORT");
		expect(compiled.files.get("world/plan.vrf")).toContain(
			'IMPORT "discovery.vrf"',
		);
		const scratch = compiled.files.get("world/scratch.vrf") ?? "";
		expect(scratch).toContain('IMPORT "discovery.vrf"');
		expect(scratch).toContain('IMPORT "plan.vrf"');
		expect(scratch).toContain('IMPORT "task_alpha.vrf"');
		const entry = compiled.files.get(WORLD_ENTRY_NAME) ?? "";
		expect(entry).toContain("CHECK BIDIRECTIONAL");
	});

	it("demotes stale observations to planner beliefs and strips BECAUSE", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 3,
			statements: [
				world("w1", ['FACT cache is_lru BECAUSE "read src/cache.ts"'], {
					anchor: { path: "src/cache.ts", hash: "old" },
				}),
				world("w2", ["NOT  logger is_verbose"], {
					anchor: { path: "src/log.ts", hash: "old" },
				}),
			],
		};
		const compiled = compileWorld(record, {
			stale: [
				{ statementId: "w1", path: "src/cache.ts" },
				{ statementId: "w2", path: "src/log.ts" },
			],
		});
		const discovery = compiled.files.get("world/discovery.vrf") ?? "";
		expect(discovery).toContain("BELIEVES planner cache is_lru");
		expect(discovery).not.toContain("BECAUSE");
		expect(discovery).toContain("BELIEVES planner NOT logger is_verbose");
		expect(compiled.demoted).toHaveLength(2);
	});

	it("includes the spec as the ground layer with a rewritten template import", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 2,
			statements: [world("w1", ["FACT cache is_lru"])],
		};
		const compiled = compileWorld(record, { spec: minimalSpec() });
		const spec = compiled.files.get("world/spec.vrf") ?? "";
		expect(spec).toContain('IMPORT "../templates/spec-consistency.vrf"');
		expect(spec).not.toContain('IMPORT "templates/');
		expect(compiled.values["spec_gate.spec_verified"]).toBe(true);
		expect(compiled.files.get("world/discovery.vrf")).toContain(
			'IMPORT "spec.vrf"',
		);
	});

	it("maps every emitted statement line back to its statement id", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 3,
			statements: [
				world("w1", ["FACT cache is_lru"]),
				world("w2", [
					"PREMISE only_one:",
					"    EXCLUSIVE",
					"    db is_postgres",
					"    db is_sqlite",
				]),
			],
		};
		const compiled = compileWorld(record);
		const discovery = (compiled.files.get("world/discovery.vrf") ?? "").split(
			"\n",
		);
		expect(
			compiled.sourceMap.filter((e) => e.statementId === "w2"),
		).toHaveLength(4);
		for (const entry of compiled.sourceMap) {
			const line = discovery[entry.line - 1] ?? "";
			expect(entry.file).toBe("world/discovery.vrf");
			expect(line.trim().length).toBeGreaterThan(0);
		}
	});

	it("throws on a hand-edited registry with an invalid domain", () => {
		const record: WorldRecord = {
			version: 1,
			nextId: 2,
			statements: [world("w1", ["FACT a b"], { domain: "../evil" })],
		};
		expect(() => compileWorld(record)).toThrow(/invalid domain/);
	});
});

describe("world run through the real engine", () => {
	const fs = createNodeFs();
	const roots: string[] = [];

	afterAll(async () => {
		await Promise.all(
			roots.map((root) => rm(root, { recursive: true, force: true })),
		);
	});

	async function livePaths(): Promise<PlanStoragePaths> {
		const root = await mkdtemp(join(tmpdir(), "world-store-"));
		roots.push(root);
		const projectPaths = createProjectStoragePaths({
			agentDir: join(root, "agent"),
			projectRoot: join(root, "repo"),
		});
		const planPaths = createPlanStoragePaths(projectPaths, "plan-live");
		await fs.mkdirp(planPaths.elenchusDir);
		await syncVrfTemplatesToPlan(fs, { projectPaths, planPaths });
		return planPaths;
	}

	it("checks a healthy cross-domain world, persists the verdict, and returns raw output", async () => {
		const planPaths = await livePaths();
		await assertWorldStatements(fs, planPaths, [
			statement(["FACT cache is_lru"]),
			// A RULE (not a PREMISE) so the cross-domain consequence is actually
			// derived — a bare PREMISE would leave task_1 undetermined (WARNING).
			statement(
				[
					"RULE needs_cache:",
					"    WHEN discovery.cache is_lru",
					"    THEN task_1 is_ready",
				],
				{ domain: "plan" },
			),
		]);
		const run = await runWorldCheck(fs, planPaths, {
			now: () => "2026-07-07T00:00:00.000Z",
		});
		expect(run.ok, run.ok ? "" : run.reason).toBe(true);
		if (!run.ok) return;
		expect(run.verdict).toBe("CONSISTENT");
		// The store never parses the report — the derived consequence reaches the
		// caller (and thus the model) in the raw output verbatim.
		expect(run.output).toContain("plan.task_1 is_ready");
		const persisted = await readWorldRunRecord(fs, planPaths);
		expect(persisted?.verdict).toBe("CONSISTENT");
		expect(persisted?.worldHash).toBe(run.compiled.worldHash);
	});

	it("demoted stale knowledge cannot raise a false CONFLICT, and the false belief shows in the raw output", async () => {
		const planPaths = await livePaths();
		const originalContent = "export const CACHE = 'lru';\n";
		await assertWorldStatements(fs, planPaths, [
			statement(["FACT cache is_lru"], {
				anchor: { path: "src/cache.ts", hash: sha256(originalContent) },
			}),
			statement(["FACT cache uses_fifo"]),
			statement([
				"RULE fifo_not_lru:",
				"    WHEN cache uses_fifo",
				"    THEN NOT cache is_lru",
			]),
		]);
		// As plain FACTs this world is contradictory; with the anchor stale the
		// observation demotes to a belief and the engine stays CONSISTENT while
		// deriving the belief's negation (the named "false belief" nudge). The
		// staleness the planner acts on is its own compiled `demoted` list.
		const run = await runWorldCheck(fs, planPaths, {
			hashProjectFile: async () => sha256("export const CACHE = 'fifo';\n"),
		});
		expect(run.ok, run.ok ? "" : run.reason).toBe(true);
		if (!run.ok) return;
		expect(run.verdict).toBe("CONSISTENT");
		expect(run.compiled.demoted).toEqual([
			{ statementId: "w1", path: "src/cache.ts" },
		]);
		// The contradicted claim and its owning agent are visible in the raw
		// output for the model to read — pi-planner itself never parses them out.
		expect(run.output).toContain("discovery.cache is_lru");
		expect(run.output).toContain("planner");
	});

	it("a contradictory world yields CONFLICT and the raw output carries the repair", async () => {
		const planPaths = await livePaths();
		await assertWorldStatements(fs, planPaths, [
			statement(["FACT db is_postgres"]),
			statement(["ASSUME db is_sqlite"]),
			statement([
				"PREMISE only_one:",
				"    EXCLUSIVE",
				"    db is_postgres",
				"    db is_sqlite",
			]),
		]);
		const run = await runWorldCheck(fs, planPaths);
		expect(run.ok, run.ok ? "" : run.reason).toBe(true);
		if (!run.ok) return;
		expect(run.verdict).toBe("CONFLICT");
		// The conflicting atom and the drop/flip repair reach the model in the raw
		// output; the store's only reading of it is the verdict scan above.
		expect(run.output).toContain("discovery.db is_postgres");
		expect(run.output).toContain("drop");
	});

	it("checks spec + world together through the synced template", async () => {
		const planPaths = await livePaths();
		await assertWorldStatements(fs, planPaths, [
			statement(["FACT cache is_lru"]),
		]);
		const run = await runWorldCheck(fs, planPaths, { spec: minimalSpec() });
		expect(run.ok, run.ok ? "" : run.reason).toBe(true);
		if (!run.ok) return;
		expect(["CONSISTENT", "WARNING"]).toContain(run.verdict);
		expect(run.output).toContain("req_1_ok");
	});

	it("surfaces a plain-text engine diagnostic as a failed run, not a crash", async () => {
		const planPaths = await livePaths();
		await assertWorldStatements(fs, planPaths, [
			// Parses as a keyword-led statement but is semantically broken: the
			// premise body is missing its THEN.
			statement(["PREMISE broken:", "    WHEN a b"]),
		]);
		const run = await runWorldCheck(fs, planPaths);
		expect(run.ok).toBe(false);
		if (run.ok) return;
		expect(run.reason.length).toBeGreaterThan(0);
	});

	it("an empty world checks clean (the vacuum is CONSISTENT; fuel scoring is a separate concern)", async () => {
		const planPaths = await livePaths();
		const run = await runWorldCheck(fs, planPaths);
		expect(run.ok, run.ok ? "" : run.reason).toBe(true);
		if (!run.ok) return;
		expect(run.verdict).toBe("CONSISTENT");
	});
});

describe("engine decoupling invariant", () => {
	it("the store never parses the engine report — only the verdict token", () => {
		// The anti-regression guard for this whole redesign: pi-planner must not
		// grow a dependency on the engine's private JSON shape for model-authored
		// programs. If a future edit reads report internals here, this fails.
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "world-store.ts"),
			"utf8",
		);
		for (const forbidden of [
			"elenchus-report",
			"ElenchusJsonReport",
			"parseElenchusReport",
			".orphans",
			".beliefs",
			".derived",
			".retract",
			".unsat_core",
			".fixes",
			".tried",
			".goals",
			".derivation",
		]) {
			expect(
				source,
				`world-store must not reference ${forbidden}`,
			).not.toContain(forbidden);
		}
	});
});

function world(
	id: string,
	lines: string[],
	overrides: Partial<Omit<WorldStatement, "id" | "lines">> = {},
): WorldStatement {
	const kind = overrides.kind ?? inferKindForTest(lines[0] ?? "");
	return {
		id,
		kind,
		lines,
		domain: "discovery",
		origin: ORIGIN,
		assertedAt: "2026-07-07T00:00:00.000Z",
		...overrides,
	};
}

function inferKindForTest(firstLine: string): WorldStatement["kind"] {
	const keyword = firstLine.trim().split(/\s+/, 1)[0] ?? "";
	switch (keyword) {
		case "FACT":
			return "fact";
		case "NOT":
			return "not";
		case "ASSUME":
			return "assume";
		case "RULE":
			return "rule";
		case "PREMISE":
			return "premise";
		default:
			return "fact";
	}
}

function minimalSpec(): SpecRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		requirements: [
			{
				id: "REQ-1",
				statement: "The cache evicts least-recently-used entries.",
				acceptance: "Eviction test passes.",
				acceptanceAtom: "req_1_ok",
				priority: "must",
				inScope: true,
			},
		],
		nonGoals: [],
		constraints: [],
		assumptions: [],
	};
}
