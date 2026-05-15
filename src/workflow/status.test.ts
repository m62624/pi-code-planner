import { describe, expect, it } from "vitest";
import {
	deriveAttemptStatus,
	derivePlanStatus,
	deriveWorkItemStatus,
} from "./status";

describe("derivePlanStatus", () => {
	it("maps planning stages to draft", () => {
		expect(derivePlanStatus("plan_draft")).toBe("draft");
		expect(derivePlanStatus("stub_audit")).toBe("draft");
		expect(derivePlanStatus("plan_ready")).toBe("draft");
	});

	it("maps active and terminal plan stages", () => {
		expect(derivePlanStatus("plan_active")).toBe("active");
		expect(derivePlanStatus("plan_finalize")).toBe("active");
		expect(derivePlanStatus("recovery_required")).toBe("blocked");
		expect(derivePlanStatus("plan_completed")).toBe("completed");
		expect(derivePlanStatus("plan_cancelled")).toBe("cancelled");
	});
});

describe("deriveWorkItemStatus", () => {
	it("maps work item lifecycle stages", () => {
		expect(deriveWorkItemStatus("pending")).toBe("pending");
		expect(deriveWorkItemStatus("ready")).toBe("ready");
		expect(deriveWorkItemStatus("tdd_write_tests")).toBe("active");
		expect(deriveWorkItemStatus("work_item_compact_required")).toBe("active");
		expect(deriveWorkItemStatus("completed")).toBe("completed");
		expect(deriveWorkItemStatus("blocked")).toBe("blocked");
		expect(deriveWorkItemStatus("failed")).toBe("failed");
		expect(deriveWorkItemStatus("skipped")).toBe("skipped");
	});
});

describe("deriveAttemptStatus", () => {
	it("maps attempt lifecycle stages", () => {
		expect(deriveAttemptStatus("created")).toBe("created");
		expect(deriveAttemptStatus("implemented")).toBe("active");
		expect(deriveAttemptStatus("candidate")).toBe("candidate");
		expect(deriveAttemptStatus("selected")).toBe("selected");
		expect(deriveAttemptStatus("rejected")).toBe("rejected");
		expect(deriveAttemptStatus("deleted")).toBe("deleted");
	});
});
