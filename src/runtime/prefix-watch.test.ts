import { describe, expect, it } from "vitest";
import {
	comparePayloads,
	describePayload,
	fingerprintHead,
	formatHeadChurnWarning,
	PrefixWatch,
} from "./prefix-watch";

// An openai-completions payload, which is what a llama.cpp server speaks: the
// system prompt is the leading message and the tool schemas ride alongside.
function payload(input: { tools?: string[]; system?: string; turns?: number }) {
	return {
		messages: [
			{ role: "system", content: input.system ?? "you are a planner" },
			...Array.from({ length: input.turns ?? 1 }, (_, i) => ({
				role: "user",
				content: `turn ${i}`,
			})),
		],
		tools: (input.tools ?? ["planner_status"]).map((name) => ({
			type: "function",
			function: { name, parameters: {} },
		})),
	};
}

describe("describePayload", () => {
	it("counts the system prompt and the tool schemas as the head", () => {
		const shape = describePayload(payload({ tools: ["a", "b"] }));
		expect(shape.toolNames).toEqual(["a", "b"]);
		expect(shape.toolChars).toBeGreaterThan(0);
		// The head is the serialized system message plus the serialized schemas —
		// what the backend actually reads, not just the prose inside them.
		const systemChars = JSON.stringify({
			role: "system",
			content: "you are a planner",
		}).length;
		expect(shape.headChars).toBe(systemChars + shape.toolChars);
		// The conversation is not the head — it comes after it.
		expect(shape.messages).toBe(1);
		expect(shape.messageChars).toBeGreaterThan(0);
	});

	it("reads an Anthropic-style system field as well as a leading message", () => {
		const shape = describePayload({
			system: "abc",
			messages: [{ role: "user", content: "hi" }],
			tools: [],
		});
		expect(shape.headChars).toBe(3);
		expect(shape.messages).toBe(1);
	});

	it("charges nothing for an empty tool list", () => {
		// Faithful to the payload, which omits the key, and to the prompt, where an
		// empty list renders to nothing.
		expect(describePayload({ messages: [], tools: [] }).toolChars).toBe(0);
	});

	it("survives a payload that is not an object", () => {
		expect(describePayload(null).headChars).toBe(0);
		expect(describePayload("nonsense").toolNames).toEqual([]);
	});

	it("names tools in both provider shapes", () => {
		const shape = describePayload({
			messages: [],
			tools: [{ function: { name: "wrapped" } }, { name: "bare" }, 42],
		});
		expect(shape.toolNames).toEqual(["wrapped", "bare", "?"]);
	});
});

describe("head fingerprint", () => {
	it("is equal for equal bytes and different for a one-character change", () => {
		expect(fingerprintHead("abc")).toBe(fingerprintHead("abc"));
		expect(fingerprintHead("abc")).not.toBe(fingerprintHead("abd"));
	});

	it("separates the same tools offered in a different order", () => {
		// Order is part of the bytes: a reordered tool list is a different head, and
		// a backend re-reads the whole prompt for it.
		const a = describePayload(payload({ tools: ["x", "y"] }));
		const b = describePayload(payload({ tools: ["y", "x"] }));
		expect(a.headKey).not.toBe(b.headKey);
		expect(comparePayloads(a, b).headStable).toBe(false);
	});

	it("is unmoved by a growing conversation", () => {
		// The whole point: messages accumulate, the head does not, and the prefix
		// stays reusable.
		const a = describePayload(payload({ turns: 1 }));
		const b = describePayload(payload({ turns: 9 }));
		expect(comparePayloads(a, b).headStable).toBe(true);
	});
});

describe("comparePayloads", () => {
	it("reports which tools were gained and lost, and by how much", () => {
		const a = describePayload(payload({ tools: ["keep", "drop"] }));
		const b = describePayload(payload({ tools: ["keep", "add"] }));
		const delta = comparePayloads(a, b);
		expect(delta.headStable).toBe(false);
		expect(delta.toolsAdded).toEqual(["add"]);
		expect(delta.toolsRemoved).toEqual(["drop"]);
		expect(delta.headCharsDelta).not.toBe(Number.NaN);
	});
});

describe("PrefixWatch", () => {
	const OURS = ["planner_status"];

	it("says nothing about the first request of a session", () => {
		const watch = new PrefixWatch();
		expect(watch.record(payload({}), OURS)).toBeNull();
	});

	it("says nothing while the head holds still", () => {
		const watch = new PrefixWatch();
		watch.record(payload({ turns: 1 }), OURS);
		expect(watch.record(payload({ turns: 2 }), OURS)).toBeNull();
		expect(watch.history()).toEqual([]);
	});

	it("marks a change within one run as mid-run", () => {
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		const churn = watch.record(payload({ tools: ["a", "b"] }), ["a", "b"]);
		expect(churn?.midRun).toBe(true);
	});

	it("does not blame the first request after a run boundary", () => {
		// Between runs the tool set may legitimately differ; that is not the defect.
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		watch.runStarted();
		const churn = watch.record(payload({ tools: ["a", "b"] }), ["a", "b"]);
		expect(churn?.midRun).toBe(false);
		expect(watch.defects()).toEqual([]);
	});

	it("recognises its own footsteps and does not report them as a defect", () => {
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		const churn = watch.record(payload({ tools: ["a", "b"] }), ["a", "b"]);
		expect(churn?.foreign).toBe(false);
		expect(watch.defects()).toEqual([]);
	});

	it("reports a mid-run head somebody else wrote", () => {
		// The bug this exists to name: another extension rebuilt the whole active
		// tool list on a request of ours, and the backend re-read the prompt.
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		const churn = watch.record(payload({ tools: ["a", "stranger"] }), ["a"]);
		expect(churn?.foreign).toBe(true);
		expect(watch.defects()).toHaveLength(1);
	});

	it("accuses nobody when it does not know what it last set", () => {
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), null);
		const churn = watch.record(payload({ tools: ["b"] }), null);
		expect(churn?.foreign).toBe(false);
	});

	it("keeps only the newest churns", () => {
		const watch = new PrefixWatch(() => 0, 2);
		watch.runStarted();
		for (const tools of [["a"], ["b"], ["c"], ["d"]]) {
			watch.record(payload({ tools }), tools);
		}
		expect(watch.history()).toHaveLength(2);
		expect(watch.history()[0]?.shape.toolNames).toEqual(["d"]);
	});

	it("remembers the last shape it saw", () => {
		const watch = new PrefixWatch();
		expect(watch.current()).toBeNull();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		expect(watch.current()?.toolNames).toEqual(["a"]);
	});
});

describe("formatHeadChurnWarning", () => {
	it("says what moved, by how much, and that nothing left the machine", () => {
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload({ tools: ["a"] }), ["a"]);
		const churn = watch.record(payload({ tools: ["a", "stranger"] }), ["a"]);
		const text = formatHeadChurnWarning(
			churn ??
				(() => {
					throw new Error("expected a churn");
				})(),
		);
		expect(text).toContain("mid-run");
		expect(text).toContain("stranger");
		expect(text).toContain("nothing was sent anywhere");
	});
});
