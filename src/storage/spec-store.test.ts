import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { MockPlannerFs } from "../test/mock-fs";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import {
	formatSpecMarkdown,
	readSpecRecord,
	readSpecRecordIfExists,
	type SpecRecordInput,
	validateSpecRecord,
	writeSpecArtifacts,
} from "./spec-store";

function planPaths() {
	return createPlanStoragePaths(
		createProjectStoragePaths({ agentDir: "/agent", projectRoot: "/repo/app" }),
		"plan-a",
	);
}

function validInput(): SpecRecordInput {
	return {
		requirements: [
			{
				id: "REQ-1",
				statement: "Config parsing rejects invalid input.",
				acceptance: "Invalid input returns a typed error.",
				acceptanceAtom: "invalid_input_rejected",
				priority: "must",
				inScope: true,
			},
			{
				id: "REQ-2",
				statement: "Error messages feel calm and helpful.",
				acceptance: "Reviewed by a human against tone guidance.",
				priority: "should",
				inScope: true,
				deferral: { rationale: "Tone is taste, not a checkable boolean web." },
			},
		],
		nonGoals: ["No YAML support."],
		constraints: [
			{
				id: "CON-1",
				statement: "Public API stays unchanged.",
				kind: "invariant",
			},
		],
		assumptions: [
			{
				id: "ASM-1",
				atom: "latency_within_budget",
				negated: false,
				statement: "Measured 187ms < 200ms budget via `npm run bench`.",
			},
		],
	};
}

describe("spec store", () => {
	it("validates, persists, and re-reads a spec record; spec.md is rendered", async () => {
		const fs = new MockPlannerFs();
		const paths = planPaths();
		const record = validateSpecRecord(validInput());
		expect(record.schemaVersion).toBe(SCHEMA_VERSION);

		await writeSpecArtifacts(fs, paths, record);
		expect(await readSpecRecord(fs, paths)).toEqual(record);
		expect(await readSpecRecordIfExists(fs, paths)).toEqual(record);

		const md = await fs.readText(paths.specMd);
		expect(md).toContain("### REQ-1 — Config parsing rejects invalid input.");
		expect(md).toContain("- Acceptance atom: `invalid_input_rejected`");
		expect(md).toContain("Deferred to human judgment (freedom valve):");
		expect(md).toContain("CON-1 — Public API stays unchanged.");
		expect(md).toContain("`latency_within_budget`");
	});

	it("returns null for a legacy plan without spec.json", async () => {
		expect(await readSpecRecordIfExists(new MockPlannerFs(), planPaths())).toBe(
			null,
		);
	});

	it("rejects an unexplained acceptanceAtom omission (REQ-14)", () => {
		const input = validInput();
		input.requirements[1] = {
			...input.requirements[1],
			deferral: undefined,
		};
		expect(() => validateSpecRecord(input)).toThrow("deferral.rationale");
	});

	it("rejects a requirement that is both formalized and deferred", () => {
		const input = validInput();
		input.requirements[0] = {
			...input.requirements[0],
			deferral: { rationale: "also deferred" },
		};
		expect(() => validateSpecRecord(input)).toThrow("mutually exclusive");
	});

	it("rejects invalid VRF atoms with a self-contained message", () => {
		for (const atom of ["Bad Atom", "1starts_with_digit", "has.dot", "CAPS"]) {
			const input = validInput();
			input.requirements[0] = {
				...input.requirements[0],
				acceptanceAtom: atom,
			};
			expect(() => validateSpecRecord(input)).toThrow("lowercase snake_case");
		}
	});

	it("rejects duplicate ids and duplicate atoms", () => {
		const dupId = validInput();
		dupId.requirements[1] = { ...dupId.requirements[1], id: "REQ-1" };
		expect(() => validateSpecRecord(dupId)).toThrow("more than once");

		const dupAtom = validInput();
		dupAtom.assumptions = [
			{
				id: "ASM-1",
				atom: "invalid_input_rejected",
				negated: false,
				statement: "Collides with REQ-1's acceptance atom.",
			},
		];
		expect(() => validateSpecRecord(dupAtom)).toThrow("must be unique");
	});

	it("rejects malformed ids, priorities, and empty statements", () => {
		const badId = validInput();
		badId.requirements[0] = { ...badId.requirements[0], id: "REQ-x" };
		expect(() => validateSpecRecord(badId)).toThrow("REQ-<n>");

		const badPriority = validInput();
		badPriority.requirements[0] = {
			...badPriority.requirements[0],
			// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
			priority: "urgent" as any,
		};
		expect(() => validateSpecRecord(badPriority)).toThrow(
			"must | should | could",
		);

		const badEvidence = validInput();
		badEvidence.assumptions = [
			{ id: "ASM-1", atom: "leaf", negated: false, statement: "   " },
		];
		expect(() => validateSpecRecord(badEvidence)).toThrow("non-empty string");
	});

	it("rejects an empty requirements list", () => {
		expect(() =>
			validateSpecRecord({ ...validInput(), requirements: [] }),
		).toThrow("at least one requirement");
	});

	it("renders deterministic markdown", () => {
		const record = validateSpecRecord(validInput());
		expect(formatSpecMarkdown(record)).toBe(formatSpecMarkdown(record));
	});
});

// The spec-stage window compaction (compact_spec) was removed; spec durability
// (REQ-9) no longer rides a dedicated compact step. spec.md/spec.json persist on
// disk and survive any compaction — covered by the persistence round-trip tests
// above and in storage.test.ts.
