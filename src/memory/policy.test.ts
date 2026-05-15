import { describe, expect, it } from "vitest";
import { checkMemoryPolicy } from "./policy";

describe("checkMemoryPolicy", () => {
	it("allows protected operations when memory is clean", () => {
		const decision = checkMemoryPolicy({
			operation: "request_compact",
			dirty: { files: {} },
		});

		expect(decision).toEqual({
			kind: "allow",
			operation: "request_compact",
			message: "Project memory is clean.",
		});
	});

	it("blocks protected operations while files are dirty", () => {
		const decision = checkMemoryPolicy({
			operation: "finish_work_item",
			dirty: {
				files: {
					"src/config.ts": {
						filePath: "src/config.ts",
						reason: "edit result",
						markedAt: "2026-05-15T00:00:00.000Z",
					},
				},
			},
		});

		expect(decision).toEqual({
			kind: "block",
			operation: "finish_work_item",
			message:
				"Project memory has 1 dirty file(s); run signature_refresh before finish_work_item.",
			dirtyFiles: ["src/config.ts"],
		});
	});
});
