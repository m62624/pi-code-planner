import { describe, expect, it } from "vitest";
import { runElenchusCheck } from "../runtime/elenchus-engine";
import { createNodeFs } from "../storage/fs";
import {
	type SpecRecordInput,
	validateSpecRecord,
} from "../storage/spec-store";
import { loadBundledVrfTemplates } from "./defaults";
import type { VrfTemplateName } from "./schema";
import {
	compileSpecConsistency,
	specRequirementSubject,
	specSubjectToRequirementId,
} from "./spec-compiler";

const fs = createNodeFs();

/** Compile a spec and run it through the REAL wasm engine (no mocks). */
async function checkSpec(input: SpecRecordInput) {
	const spec = validateSpecRecord(input);
	const compiled = compileSpecConsistency(spec);
	const templates = await loadBundledVrfTemplates(fs);
	const read = (path: string): string => {
		if (path === "spec-consistency.vrf") return compiled.program;
		const match = /^templates\/(.+)\.vrf$/.exec(path);
		const name = match?.[1] as VrfTemplateName | undefined;
		if (name && templates[name] !== undefined) return templates[name];
		throw new Error(`not found: ${path}`);
	};
	const run = await runElenchusCheck({
		root: "spec-consistency.vrf",
		read,
		format: "json",
		values: compiled.values,
	});
	expect(run.ok, run.ok ? "" : run.reason).toBe(true);
	if (!run.ok) throw new Error(run.reason);
	return {
		compiled,
		report: JSON.parse(run.output) as {
			status: string;
			warnings: Array<{ premise?: string; blocked_by?: string[] }>;
			conflicts: Array<{ atoms?: string[] }>;
			underdetermined: string | null;
		},
	};
}

function req(
	n: number,
	overrides: Partial<SpecRecordInput["requirements"][number]> = {},
): SpecRecordInput["requirements"][number] {
	return {
		id: `REQ-${n}`,
		statement: `Requirement ${n}.`,
		acceptance: `Acceptance ${n}.`,
		acceptanceAtom: `req_${n}_ok`,
		priority: "must",
		inScope: true,
		...overrides,
	};
}

describe("spec→VRF compiler through the real engine", () => {
	it("is deterministic: same spec, byte-identical program", () => {
		const input: SpecRecordInput = {
			requirements: [req(2), req(1)],
			assumptions: [
				{ id: "ASM-1", atom: "leaf_a", negated: false, statement: "evidence" },
			],
		};
		const a = compileSpecConsistency(validateSpecRecord(input));
		const b = compileSpecConsistency(validateSpecRecord(input));
		expect(a.program).toBe(b.program);
		// Sorted by id: REQ-1 before REQ-2 regardless of input order.
		expect(a.program.indexOf("req_1")).toBeLessThan(a.program.indexOf("req_2"));
	});

	it("honest formalized spec → CONSISTENT (mirrors models/p2)", async () => {
		const { report } = await checkSpec({ requirements: [req(1), req(2)] });
		expect(report.status).toBe("CONSISTENT");
	});

	it("inexpressible requirement deferred with a rationale → CONSISTENT (mirrors models/p1)", async () => {
		const { report } = await checkSpec({
			requirements: [
				req(1),
				req(2, {
					acceptanceAtom: undefined,
					deferral: { rationale: "Tone is taste, not a boolean web." },
				}),
			],
		});
		expect(report.status).toBe("CONSISTENT");
	});

	it("a constraint referencing an unestablished atom → WARNING naming the atom (the elicit-gaps script)", async () => {
		const { report } = await checkSpec({
			requirements: [req(1)],
			assumptions: [
				{
					id: "ASM-1",
					atom: "latency_within_budget",
					negated: false,
					statement: "Measured 187ms < 200ms via npm run bench.",
				},
			],
			constraints: [
				{
					id: "CON-1",
					statement: "Staying in budget requires the cache.",
					kind: "invariant",
					relation: {
						type: "implies",
						when: ["latency_within_budget"],
						then: "cache_enabled",
					},
				},
			],
		});
		expect(report.status).toBe("WARNING");
		const blocked = report.warnings.flatMap((w) => w.blocked_by ?? []);
		expect(blocked.join(" ")).toContain("cache_enabled");
	});

	it("contradictory constraint web → CONFLICT (requirements + constraints are mutually checked)", async () => {
		const { report } = await checkSpec({
			requirements: [req(1)],
			assumptions: [
				{ id: "ASM-1", atom: "mode_fast", negated: false, statement: "chosen" },
				{ id: "ASM-2", atom: "mode_safe", negated: false, statement: "chosen" },
			],
			constraints: [
				{
					id: "CON-1",
					statement: "Fast and safe modes are mutually exclusive.",
					kind: "invariant",
					relation: { type: "exclusive", atoms: ["mode_fast", "mode_safe"] },
				},
			],
		});
		expect(report.status).toBe("CONFLICT");
	});

	it("negated assumption violating an implies-constraint → CONFLICT", async () => {
		const { report } = await checkSpec({
			requirements: [req(1)],
			assumptions: [
				{
					id: "ASM-1",
					atom: "input_untrusted",
					negated: false,
					statement: "e",
				},
				{ id: "ASM-2", atom: "input_sanitized", negated: true, statement: "e" },
			],
			constraints: [
				{
					id: "CON-1",
					statement: "Untrusted input must be sanitized.",
					kind: "invariant",
					relation: {
						type: "implies",
						when: ["input_untrusted"],
						then: "input_sanitized",
					},
				},
			],
		});
		expect(report.status).toBe("CONFLICT");
	});

	it("a gamed 'formalized' on an inexpressible requirement → CONFLICT (mirrors models/gate-gamed)", async () => {
		// The compiler cannot emit this from a validated spec (submit-time
		// validation forbids it), so build the lie by patching the program —
		// this proves the TEMPLATE catches it even if the store is bypassed
		// (hand-edited spec.json, a compiler regression).
		const spec = validateSpecRecord({ requirements: [req(1)] });
		const compiled = compileSpecConsistency(spec);
		const gamed = compiled.program.replace(
			"FACT spec_gate.req_1 vrf_expressible",
			"NOT  spec_gate.req_1 vrf_expressible",
		);
		expect(gamed).not.toBe(compiled.program);
		const templates = await loadBundledVrfTemplates(fs);
		const run = await runElenchusCheck({
			root: "gamed.vrf",
			read: (path) =>
				path === "gamed.vrf"
					? gamed
					: templates[
							/^templates\/(.+)\.vrf$/.exec(path)?.[1] as VrfTemplateName
						],
			format: "json",
			values: compiled.values,
		});
		expect(run.ok).toBe(true);
		if (run.ok) {
			const report = JSON.parse(run.output) as { status: string };
			expect(report.status).toBe("CONFLICT");
			expect(run.output).toContain("no_fake_formal");
		}
	});

	it("an unaddressed requirement blocks the claim and is NAMED (mirrors models/p3)", async () => {
		// Same bypass technique: strip the rationale fact the valve needs.
		const spec = validateSpecRecord({
			requirements: [
				req(1, {
					acceptanceAtom: undefined,
					deferral: { rationale: "recorded" },
				}),
			],
		});
		const compiled = compileSpecConsistency(spec);
		const lazy = compiled.program.replace(
			"FACT spec_gate.req_1 rationale_recorded",
			"NOT  spec_gate.req_1 rationale_recorded",
		);
		const templates = await loadBundledVrfTemplates(fs);
		const run = await runElenchusCheck({
			root: "lazy.vrf",
			read: (path) =>
				path === "lazy.vrf"
					? lazy
					: templates[
							/^templates\/(.+)\.vrf$/.exec(path)?.[1] as VrfTemplateName
						],
			format: "json",
			values: compiled.values,
		});
		expect(run.ok).toBe(true);
		if (run.ok) {
			const report = JSON.parse(run.output) as {
				status: string;
				warnings: Array<{ blocked_by?: string[] }>;
			};
			expect(report.status).not.toBe("CONSISTENT");
			expect(
				report.warnings.flatMap((w) => w.blocked_by ?? []).join(" "),
			).toContain("req_1");
		}
	});

	it("out-of-scope requirements are excluded from the gate (REQ-3)", async () => {
		const { compiled, report } = await checkSpec({
			requirements: [
				req(1),
				req(2, {
					inScope: false,
					acceptanceAtom: undefined,
					deferral: { rationale: "descoped by the user" },
				}),
			],
		});
		expect(compiled.requirementCount).toBe(1);
		expect(compiled.program).not.toContain("req_2");
		expect(report.status).toBe("CONSISTENT");
	});

	it("acceptance atoms become advisory PROVE goals", async () => {
		const { compiled } = await checkSpec({ requirements: [req(1)] });
		expect(compiled.program).toContain("PROVE req_1_ok holds");
	});

	it("subject encoding round-trips", () => {
		expect(specRequirementSubject("REQ-12")).toBe("req_12");
		expect(specSubjectToRequirementId("req_12")).toBe("REQ-12");
		expect(specSubjectToRequirementId("other")).toBe("other");
	});
});
