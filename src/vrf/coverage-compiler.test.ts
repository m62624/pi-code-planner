import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { runElenchusCheck } from "../runtime/elenchus-engine";
import type { TaskRecord } from "../storage/schema";
import {
	type SpecRecordInput,
	validateSpecRecord,
} from "../storage/spec-store";
import { compilePlanCoverage } from "./coverage-compiler";

function spec(input?: Partial<SpecRecordInput>) {
	return validateSpecRecord({
		requirements: [
			{
				id: "REQ-1",
				statement: "One.",
				acceptance: "A1.",
				acceptanceAtom: "req_1_ok",
				priority: "must",
				inScope: true,
			},
			{
				id: "REQ-2",
				statement: "Two.",
				acceptance: "A2.",
				acceptanceAtom: "req_2_ok",
				priority: "must",
				inScope: true,
			},
			{
				id: "REQ-3",
				statement: "Taste.",
				acceptance: "Human-reviewed.",
				priority: "could",
				inScope: true,
				deferral: { rationale: "Inexpressible; human judgment." },
			},
		],
		...input,
	});
}

function task(
	taskId: string,
	requirements: string[],
	dependsOn: string[] = [],
): TaskRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		taskId,
		title: taskId,
		status: "pending",
		objective: "o",
		scope: [],
		acceptanceCriteria: ["c"],
		requirements,
		dependsOn,
	};
}

async function run(program: string) {
	const result = await runElenchusCheck({
		root: "plan-coverage.vrf",
		read: () => program,
		format: "json",
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.reason);
	return JSON.parse(result.output) as {
		status: string;
		warnings: Array<{ blocked_by?: string[] }>;
	};
}

describe("plan-coverage compiler through the real engine", () => {
	it("full coverage, no orphans → CONSISTENT; deferred requirements are never totaled", async () => {
		const compiled = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1"]),
			task("beta", ["REQ-2"]),
		]);
		// REQ-3 is discharged by its deferral — it must not demand a task.
		expect(compiled.program).not.toContain("req_3");
		expect(compiled.requirementCount).toBe(2);
		const report = await run(compiled.program);
		expect(report.status).toBe("CONSISTENT");
	});

	it("a dropped requirement is NAMED (the e2e REQ-7 fixture)", async () => {
		const compiled = compilePlanCoverage(spec(), [task("alpha", ["REQ-1"])]);
		const report = await run(compiled.program);
		expect(report.status).toBe("WARNING");
		const blocked = report.warnings.flatMap((w) => w.blocked_by ?? []);
		expect(blocked.join(" ")).toContain("req_2 (no covered_by witness)");
		// Adding the covering task clears it.
		const fixed = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1"]),
			task("beta", ["REQ-2"]),
		]);
		expect((await run(fixed.program)).status).toBe("CONSISTENT");
	});

	it("an orphan task is NAMED and mapped back to its taskId", async () => {
		const compiled = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1", "REQ-2"]),
			task("stray-work", []),
		]);
		const report = await run(compiled.program);
		expect(report.status).toBe("WARNING");
		const blocked = report.warnings.flatMap((w) => w.blocked_by ?? []);
		const orphanSubject = blocked
			.find((b) => b.includes("no traces witness"))
			?.split(" ")[0];
		expect(orphanSubject).toBeDefined();
		expect(compiled.taskSubjects[orphanSubject ?? ""]).toBe("stray-work");
	});

	it("a task citing a deferred requirement is traced but the requirement is not totaled", async () => {
		const compiled = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1", "REQ-2"]),
			task("beta", ["REQ-3"]),
		]);
		const report = await run(compiled.program);
		expect(report.status).toBe("CONSISTENT");
	});

	it("collects unknown requirement references instead of emitting them", () => {
		const compiled = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1", "REQ-9"]),
		]);
		expect(compiled.unknownRequirementRefs).toEqual([
			{ taskId: "alpha", requirement: "REQ-9" },
		]);
		expect(compiled.program).not.toContain("req_9");
	});

	it("dependency mode: an infra task that discharges nothing is justified by a dependent discharging task", async () => {
		const compiled = compilePlanCoverage(spec(), [
			task("setup-project", []), // discharges nothing
			task("alpha", ["REQ-1"], ["setup-project"]),
			task("beta", ["REQ-2"], ["setup-project"]),
		]);
		expect(compiled.mode).toBe("dependency");
		// No borrowed-REQ trace: setup-project owns no requirement.
		expect(compiled.program).not.toContain("TOTAL traces ON tasks");
		expect(compiled.program).toContain("CLOSE depends_on TRANSITIVE");
		const report = await run(compiled.program);
		expect(report.status).toBe("CONSISTENT");
	});

	it("dependency mode: a truly orphan task (no discharge, nothing depends on it) is NAMED", async () => {
		const compiled = compilePlanCoverage(spec(), [
			task("setup-project", []),
			task("alpha", ["REQ-1", "REQ-2"], ["setup-project"]),
			task("stray-work", []), // nothing depends on it, discharges nothing
		]);
		const report = await run(compiled.program);
		expect(report.status).toBe("WARNING");
		const blocked = report.warnings.flatMap((w) => w.blocked_by ?? []);
		const subject = blocked
			.find((b) => b.includes("is_justified"))
			?.split(" ")[0]
			?.replace(/^plan_coverage\./, "");
		expect(subject).toBeDefined();
		expect(compiled.taskSubjects[subject ?? ""]).toBe("stray-work");
	});

	it("dependency mode: collects unknown dependsOn references", () => {
		const compiled = compilePlanCoverage(spec(), [
			task("alpha", ["REQ-1", "REQ-2"], ["ghost-task"]),
		]);
		expect(compiled.mode).toBe("dependency");
		expect(compiled.unknownDependencyRefs).toEqual([
			{ taskId: "alpha", dependsOn: "ghost-task" },
		]);
	});

	it("dependency mode: detects a dependency cycle in TS (no engine crash)", () => {
		const compiled = compilePlanCoverage(spec(), [
			task("a", ["REQ-1"], ["b"]),
			task("b", ["REQ-2"], ["a"]),
		]);
		expect(compiled.dependencyCycle).not.toBeNull();
		expect(compiled.dependencyCycle).toContain("a");
		expect(compiled.dependencyCycle).toContain("b");
		// The cyclic CLOSE is withheld so the engine never sees an invalid program.
		expect(compiled.program).not.toContain("CLOSE depends_on TRANSITIVE");
	});

	it("stays in legacy mode when no task declares dependsOn", () => {
		const compiled = compilePlanCoverage(spec(), [task("alpha", ["REQ-1"])]);
		expect(compiled.mode).toBe("legacy");
		expect(compiled.program).toContain("TOTAL traces ON tasks");
		expect(compiled.program).not.toContain("is_justified");
	});

	it("is deterministic and sanitizes/deduplicates task subjects", () => {
		const tasks = [
			task("Fix.Storage", ["REQ-1"]),
			task("fix storage", ["REQ-2"]),
		];
		const a = compilePlanCoverage(spec(), tasks);
		const b = compilePlanCoverage(spec(), tasks);
		expect(a.program).toBe(b.program);
		const subjects = Object.keys(a.taskSubjects);
		expect(new Set(subjects).size).toBe(2);
		for (const subject of subjects) {
			expect(subject).toMatch(/^task_[a-z0-9_]+$/);
		}
	});
});
