import { describe, expect, it } from "vitest";
import { describeCoverageGaps } from "./gate-tools";

/**
 * The plan_coverage gaps are the guidance the model reads when a task traces to
 * no requirement. A real run (session 6b5e6211) showed a local model thrash on an
 * orphan `init-project` setup task: it looped trying to "delete" the task (there is
 * no delete tool) and then re-upserted with `requirements` omitted, silently wiping
 * coverage. These assertions lock the reworded guidance that unblocks that case.
 */
describe("describeCoverageGaps", () => {
	function orphanReport(subject: string) {
		return {
			warnings: [{ blocked_by: [`${subject} (no traces witness)`] }],
		} as never;
	}

	it("tells an orphan setup task to cite the REQ it discharges OR enables", () => {
		const [gap] = describeCoverageGaps(orphanReport("init-project"), {
			"init-project": "Initialize Rust workspace",
		});
		expect(gap).toContain('Task "Initialize Rust workspace" is ORPHAN');
		expect(gap).toContain("discharges OR enables");
		expect(gap).toContain("prerequisite");
	});

	it("names the no-delete reality and the wipe-on-omit trap", () => {
		const [gap] = describeCoverageGaps(orphanReport("init-project"), {});
		// The model tried to delete; say there is none and give the real alternative.
		expect(gap).toContain("no delete tool");
		expect(gap).toContain("fold its scope");
		// Omitting requirements on a re-upsert wiped coverage — warn about it.
		expect(gap).toContain("resupply");
	});

	it("still reports a dropped requirement (uncovered) distinctly", () => {
		const gaps = describeCoverageGaps(
			{
				warnings: [{ blocked_by: ["req_3 (no covered_by witness)"] }],
			} as never,
			{},
		);
		expect(gaps[0]).toContain("DROPPED");
		expect(gaps[0]).not.toContain("ORPHAN");
	});
});
