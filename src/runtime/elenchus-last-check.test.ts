import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	type ElenchusLastCheckRecord,
	readElenchusLastCheck,
	writeElenchusLastCheck,
} from "./elenchus-tools";

const DIR = "/plan/elenchus";

function gateRecord(
	overrides: Partial<ElenchusLastCheckRecord> = {},
): ElenchusLastCheckRecord {
	return {
		name: "spec_consistency",
		stage: "spec",
		step: "verify_spec",
		outcome: "WARNING",
		recordedAt: "2026-07-08T00:00:00.000Z",
		gate: "spec_consistency",
		sourceHash: "hash-1",
		...overrides,
	};
}

describe("writeElenchusLastCheck — gate-thrash repeat counter", () => {
	it("starts at 0 and increments while gate, source, and verdict all repeat", async () => {
		const fs = new MockPlannerFs();
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(0);
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(1);
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(2);
	});

	it("resets when the source hash changes (real progress)", async () => {
		const fs = new MockPlannerFs();
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(1);
		await writeElenchusLastCheck(fs, DIR, gateRecord({ sourceHash: "hash-2" }));
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(0);
	});

	it("resets when the verdict changes", async () => {
		const fs = new MockPlannerFs();
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		await writeElenchusLastCheck(fs, DIR, gateRecord());
		await writeElenchusLastCheck(
			fs,
			DIR,
			gateRecord({ outcome: "CONSISTENT" }),
		);
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBe(0);
	});

	it("never sets a repeat counter on a model-authored (non-gate) check", async () => {
		const fs = new MockPlannerFs();
		const record: ElenchusLastCheckRecord = {
			name: "world",
			stage: "execution",
			step: "contract_check",
			outcome: "CONSISTENT",
			recordedAt: "2026-07-08T00:00:00.000Z",
		};
		await writeElenchusLastCheck(fs, DIR, record);
		await writeElenchusLastCheck(fs, DIR, record);
		expect((await readElenchusLastCheck(fs, DIR))?.repeat).toBeUndefined();
	});
});
