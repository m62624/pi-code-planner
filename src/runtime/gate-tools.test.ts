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

	it("tells an orphan setup task to cite its REQ or declare a dependsOn", () => {
		const [gap] = describeCoverageGaps(orphanReport("init-project"), {
			"init-project": "Initialize Rust workspace",
		});
		expect(gap).toContain('Task "Initialize Rust workspace" is ORPHAN');
		// The new structural remedy: a discharging task depends on the infra task.
		expect(gap).toContain("dependsOn");
		expect(gap).toContain("infrastructure");
	});

	it("names the no-delete reality and the wipe-on-omit trap", () => {
		const [gap] = describeCoverageGaps(orphanReport("init-project"), {});
		// The model tried to delete; say there is none and give the real alternative.
		expect(gap).toContain("no delete tool");
		expect(gap).toContain("fold its scope");
		// Omitting requirements/dependsOn on a re-upsert wiped it — warn about it.
		expect(gap).toContain("resupply");
	});

	it("maps a dependency-mode is_justified block back to the orphan taskId", () => {
		const [gap] = describeCoverageGaps(
			{
				warnings: [{ blocked_by: ["plan_coverage.task_stray is_justified"] }],
			} as never,
			{ task_stray: "stray-work" },
		);
		expect(gap).toContain('Task "stray-work" is ORPHAN');
		expect(gap).toContain("dependsOn");
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
