import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	readTaskBehaviors,
	readTaskBehaviorsIfExists,
	type TaskBehavior,
	validateTaskBehaviors,
	writeTaskBehaviors,
} from "./behavior-store";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	createTaskStoragePaths,
} from "./paths";

function bhv(n: number, overrides: Partial<TaskBehavior> = {}): TaskBehavior {
	return {
		id: `BHV-${n}`,
		statement: `Behavior ${n}.`,
		kind: "happy",
		requirement: null,
		test: null,
		status: "planned",
		...overrides,
	};
}

const red = (n: number) =>
	bhv(n, {
		status: "red",
		test: { file: "src/x.test.ts", name: `case ${n}` },
	});

describe("behavior store", () => {
	it("round-trips through disk", async () => {
		const fs = new MockPlannerFs();
		const paths = createTaskStoragePaths(
			createPlanStoragePaths(
				createProjectStoragePaths({
					agentDir: "/agent",
					projectRoot: "/repo/app",
				}),
				"plan-a",
			),
			"alpha",
		);
		expect(await readTaskBehaviorsIfExists(fs, paths)).toBe(null);
		const record = validateTaskBehaviors({
			taskId: "alpha",
			behaviors: [bhv(1), red(2)],
			previous: null,
		});
		await writeTaskBehaviors(fs, paths, record);
		expect(await readTaskBehaviors(fs, paths)).toEqual(record);
	});

	it("rejects the planned→green jump (test-first is mechanical)", () => {
		expect(() =>
			validateTaskBehaviors({
				taskId: "alpha",
				behaviors: [
					bhv(1, {
						status: "green",
						test: { file: "f", name: "n" },
					}),
				],
				previous: null,
			}),
		).toThrow("planned → green");
	});

	it("allows the ladder planned→red→green and honest regressions", () => {
		const planned = validateTaskBehaviors({
			taskId: "alpha",
			behaviors: [bhv(1)],
			previous: null,
		});
		const redRecord = validateTaskBehaviors({
			taskId: "alpha",
			behaviors: [red(1)],
			previous: planned,
		});
		const green = validateTaskBehaviors({
			taskId: "alpha",
			behaviors: [bhv(1, { status: "green", test: { file: "f", name: "n" } })],
			previous: redRecord,
		});
		expect(green.behaviors[0].status).toBe("green");
		// green → red (a regression) is honest and allowed.
		expect(
			validateTaskBehaviors({
				taskId: "alpha",
				behaviors: [red(1)],
				previous: green,
			}).behaviors[0].status,
		).toBe("red");
	});

	it("requires the witnessing test once red, and the full list on resubmit", () => {
		expect(() =>
			validateTaskBehaviors({
				taskId: "alpha",
				behaviors: [bhv(1, { status: "red" })],
				previous: null,
			}),
		).toThrow("witnessing test");

		const previous = validateTaskBehaviors({
			taskId: "alpha",
			behaviors: [red(1), bhv(2)],
			previous: null,
		});
		// Dropping the red behavior silently is rejected…
		expect(() =>
			validateTaskBehaviors({
				taskId: "alpha",
				behaviors: [bhv(2)],
				previous,
			}),
		).toThrow("missing from the submitted list");
		// …but dropping a merely planned one is allowed (plans change).
		expect(
			validateTaskBehaviors({
				taskId: "alpha",
				behaviors: [red(1)],
				previous,
			}).behaviors,
		).toHaveLength(1);
	});

	it("rejects malformed ids, kinds, requirements, and empty lists", () => {
		expect(() =>
			validateTaskBehaviors({ taskId: "a", behaviors: [], previous: null }),
		).toThrow("non-empty");
		expect(() =>
			validateTaskBehaviors({
				taskId: "a",
				behaviors: [bhv(1, { id: "B-1" })],
				previous: null,
			}),
		).toThrow("BHV-<n>");
		expect(() =>
			validateTaskBehaviors({
				taskId: "a",
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
				behaviors: [bhv(1, { kind: "smoke" as any })],
				previous: null,
			}),
		).toThrow("happy | edge | error | concurrency");
		expect(() =>
			validateTaskBehaviors({
				taskId: "a",
				behaviors: [bhv(1, { requirement: "REQ-x" })],
				previous: null,
			}),
		).toThrow("REQ-<n>");
		expect(() =>
			validateTaskBehaviors({
				taskId: "a",
				behaviors: [bhv(1), bhv(1)],
				previous: null,
			}),
		).toThrow("more than once");
	});
});
