import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type {
	TaskBehavior,
	TaskBehaviorsRecord,
} from "../storage/behavior-store";
import { computeBehaviorBoardNudges } from "./behavior-tools";

function behavior(
	overrides: Partial<TaskBehavior> & { id: string },
): TaskBehavior {
	return {
		statement: `does ${overrides.id}`,
		kind: "happy",
		requirement: null,
		test: null,
		branches: [],
		status: "planned",
		...overrides,
	};
}

function board(behaviors: TaskBehavior[]): TaskBehaviorsRecord {
	return { schemaVersion: SCHEMA_VERSION, taskId: "setup-project", behaviors };
}

describe("computeBehaviorBoardNudges", () => {
	it("flags a byte-identical resubmit as a no-op", () => {
		const record = board([behavior({ id: "BHV-1" })]);
		const previous = board([behavior({ id: "BHV-1" })]);
		const lines = computeBehaviorBoardNudges({
			previous,
			record,
			ownedRequirements: [],
			coverableRequirements: null,
		});
		expect(lines.join("\n")).toContain("No change");
	});

	it("stays silent when the board actually changed", () => {
		const previous = board([behavior({ id: "BHV-1", status: "planned" })]);
		const record = board([
			behavior({
				id: "BHV-1",
				status: "red",
				test: { file: "t.rs", name: "t" },
			}),
		]);
		const lines = computeBehaviorBoardNudges({
			previous,
			record,
			ownedRequirements: [],
			coverableRequirements: null,
		});
		expect(lines.join("\n")).not.toContain("No change");
	});

	it("names an owned in-scope requirement no behavior cites", () => {
		const record = board([behavior({ id: "BHV-1" })]);
		const lines = computeBehaviorBoardNudges({
			previous: null,
			record,
			ownedRequirements: ["REQ-1"],
			coverableRequirements: new Set(["REQ-1"]),
		}).join("\n");
		expect(lines).toContain("Owned requirements no behavior cites yet: REQ-1");
		expect(lines).toContain('"requirement": "REQ-1"');
	});

	it("stays silent once the owned requirement is cited", () => {
		const record = board([behavior({ id: "BHV-1", requirement: "REQ-1" })]);
		const lines = computeBehaviorBoardNudges({
			previous: null,
			record,
			ownedRequirements: ["REQ-1"],
			coverableRequirements: new Set(["REQ-1"]),
		});
		expect(lines.join("\n")).not.toContain("Owned requirements");
	});

	it("ignores an owned requirement the spec no longer counts as coverable", () => {
		const record = board([behavior({ id: "BHV-1" })]);
		const lines = computeBehaviorBoardNudges({
			previous: null,
			record,
			ownedRequirements: ["REQ-9"],
			// REQ-9 is owned by the task but out of scope / deferred in the spec.
			coverableRequirements: new Set(["REQ-1"]),
		});
		expect(lines.join("\n")).not.toContain("Owned requirements");
	});

	it("never nudges about requirements for a legacy plan without a spec", () => {
		const record = board([behavior({ id: "BHV-1" })]);
		const lines = computeBehaviorBoardNudges({
			previous: null,
			record,
			ownedRequirements: ["REQ-1"],
			coverableRequirements: null,
		});
		expect(lines.join("\n")).not.toContain("Owned requirements");
	});

	it("surfaces BOTH traps on the identical-resubmit loop the session hit", () => {
		// setup-project owns REQ-1, no behavior cites it, and the model resubmits
		// the same two-green board — exactly the 13-call loop from the live run.
		const twoGreen = [
			behavior({
				id: "BHV-1",
				status: "green",
				test: { file: "tests/setup.rs", name: "test_cargo_toml_exists" },
			}),
			behavior({
				id: "BHV-2",
				status: "green",
				test: { file: "tests/setup.rs", name: "test_source_files_exist" },
			}),
		];
		const lines = computeBehaviorBoardNudges({
			previous: board(twoGreen.map((b) => ({ ...b }))),
			record: board(twoGreen.map((b) => ({ ...b }))),
			ownedRequirements: ["REQ-1"],
			coverableRequirements: new Set(["REQ-1"]),
		}).join("\n");
		expect(lines).toContain("No change");
		expect(lines).toContain("Owned requirements no behavior cites yet: REQ-1");
	});
});
