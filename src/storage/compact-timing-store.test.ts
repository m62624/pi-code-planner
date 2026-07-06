import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	COMPACT_TIMING_MAX_SAMPLES,
	readCompactTimingHistory,
	recordCompactTiming,
} from "./compact-timing-store";
import { writeJson } from "./json";
import { createProjectStoragePaths } from "./paths";

const paths = createProjectStoragePaths({
	agentDir: "/agent",
	projectRoot: "/home/me/Projects/App",
});

describe("compact-timing-store", () => {
	it("returns empty history when the file is absent", async () => {
		const fs = new MockPlannerFs();
		const history = await readCompactTimingHistory(fs, paths);
		expect(history.samples).toEqual([]);
	});

	it("persists a sample under the project's storage dir", async () => {
		const fs = new MockPlannerFs();
		await recordCompactTiming(fs, paths, {
			tokens: 100_000,
			ms: 20_000,
			model: "m",
			at: 1,
		});
		expect(paths.compactTimingJson).toContain(paths.projectDir);
		const history = await readCompactTimingHistory(fs, paths);
		expect(history.samples).toHaveLength(1);
		expect(history.samples[0].tokens).toBe(100_000);
	});

	it("appends in order and trims to the newest N", async () => {
		const fs = new MockPlannerFs();
		for (let i = 0; i < COMPACT_TIMING_MAX_SAMPLES + 5; i++) {
			await recordCompactTiming(fs, paths, {
				tokens: 1000 + i,
				ms: 1000,
				model: "m",
				at: i,
			});
		}
		const history = await readCompactTimingHistory(fs, paths);
		expect(history.samples).toHaveLength(COMPACT_TIMING_MAX_SAMPLES);
		// The oldest five were dropped; the newest is last.
		expect(history.samples[0].at).toBe(5);
		expect(history.samples.at(-1)?.at).toBe(COMPACT_TIMING_MAX_SAMPLES + 4);
	});

	it("drops malformed samples on read and never throws on corrupt JSON", async () => {
		const fs = new MockPlannerFs();
		await writeJson(fs, paths.compactTimingJson, {
			version: 1,
			samples: [
				{ tokens: 100_000, ms: 20_000, model: "m", at: 1 },
				{ tokens: -5, ms: 20_000, model: "m", at: 2 },
				{ tokens: 100_000, ms: 0, model: "m", at: 3 },
				{ nonsense: true },
			],
		});
		const history = await readCompactTimingHistory(fs, paths);
		expect(history.samples).toHaveLength(1);
	});

	it("ignores an invalid sample passed to record", async () => {
		const fs = new MockPlannerFs();
		await recordCompactTiming(fs, paths, {
			tokens: Number.NaN,
			ms: 20_000,
			model: "m",
			at: 1,
		});
		const history = await readCompactTimingHistory(fs, paths);
		expect(history.samples).toEqual([]);
	});
});
