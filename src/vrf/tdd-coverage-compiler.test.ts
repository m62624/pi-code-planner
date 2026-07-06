import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { runElenchusCheck } from "../runtime/elenchus-engine";
import type {
	TaskBehavior,
	TaskBehaviorsRecord,
} from "../storage/behavior-store";
import { compileTddCoverage } from "./tdd-coverage-compiler";

function record(behaviors: TaskBehavior[]): TaskBehaviorsRecord {
	return { schemaVersion: SCHEMA_VERSION, taskId: "alpha", behaviors };
}

function bhv(n: number, status: TaskBehavior["status"]): TaskBehavior {
	return {
		id: `BHV-${n}`,
		statement: `Behavior ${n}.`,
		kind: "happy",
		requirement: null,
		test:
			status === "planned"
				? null
				: { file: "src/x.test.ts", name: `case ${n}` },
		status,
	};
}

async function run(program: string) {
	const result = await runElenchusCheck({
		root: "tdd.vrf",
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

describe("tdd-coverage compiler through the real engine", () => {
	it("red phase: an untested behavior is NAMED; all-red is CONSISTENT", async () => {
		const partial = compileTddCoverage(
			record([bhv(1, "red"), bhv(2, "planned")]),
			"red",
		);
		const report = await run(partial.program);
		expect(report.status).toBe("WARNING");
		const blocked = report.warnings.flatMap((w) => w.blocked_by ?? []);
		expect(blocked.join(" ")).toContain("bhv_2 (no has_red_test witness)");
		expect(partial.behaviorSubjects.bhv_2).toBe("BHV-2");

		const full = compileTddCoverage(
			record([bhv(1, "red"), bhv(2, "red")]),
			"red",
		);
		expect((await run(full.program)).status).toBe("CONSISTENT");
	});

	it("green phase: a red-but-not-green behavior is NAMED; all-green is CONSISTENT", async () => {
		const partial = compileTddCoverage(
			record([bhv(1, "green"), bhv(2, "red")]),
			"green",
		);
		const report = await run(partial.program);
		expect(report.status).toBe("WARNING");
		expect(
			report.warnings.flatMap((w) => w.blocked_by ?? []).join(" "),
		).toContain("bhv_2 (no has_green_test witness)");

		const full = compileTddCoverage(
			record([bhv(1, "green"), bhv(2, "green")]),
			"green",
		);
		expect((await run(full.program)).status).toBe("CONSISTENT");
	});

	it("green phase still demands the red witness (test-first stays visible)", () => {
		const compiled = compileTddCoverage(record([bhv(1, "green")]), "green");
		expect(compiled.program).toContain("TOTAL has_red_test ON behaviors");
		expect(compiled.program).toContain("TOTAL has_green_test ON behaviors");
	});

	it("is deterministic and sorts behaviors by id", () => {
		const behaviors = [bhv(10, "red"), bhv(2, "red")];
		const a = compileTddCoverage(record(behaviors), "red");
		const b = compileTddCoverage(record(behaviors), "red");
		expect(a.program).toBe(b.program);
		expect(a.program.indexOf("bhv_2")).toBeLessThan(
			a.program.indexOf("bhv_10"),
		);
	});
});
