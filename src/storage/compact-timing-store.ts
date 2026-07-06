import type { CompactTimingSample } from "../runtime/compact-eta";
import type { PlannerFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";
import type { ProjectStoragePaths } from "./paths";

/**
 * Per-project persistence for the empirical compaction-ETA history.
 *
 * Lives at `<agentDir>/extensions/<ext>/projects/<projectId>/compact-timing.json`
 * — inside the extension's own storage, one file per project — so every project
 * builds its own timing profile and none is shared or leaks across projects.
 * Missing / malformed files degrade to "no history" (the indicator then shows a
 * bare timer), never an error.
 */

const COMPACT_TIMING_VERSION = 1 as const;
/** How many recent compactions to retain per project. */
export const COMPACT_TIMING_MAX_SAMPLES = 20;

export interface CompactTimingHistory {
	version: typeof COMPACT_TIMING_VERSION;
	samples: CompactTimingSample[];
}

function emptyHistory(): CompactTimingHistory {
	return { version: COMPACT_TIMING_VERSION, samples: [] };
}

function isValidSample(value: unknown): value is CompactTimingSample {
	if (typeof value !== "object" || value === null) return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.tokens === "number" &&
		Number.isFinite(s.tokens) &&
		s.tokens > 0 &&
		typeof s.ms === "number" &&
		Number.isFinite(s.ms) &&
		s.ms > 0 &&
		(s.model === null || typeof s.model === "string") &&
		typeof s.at === "number"
	);
}

/** Read history, returning an empty (but valid) history on absence or corruption. */
export async function readCompactTimingHistory(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
): Promise<CompactTimingHistory> {
	let raw: CompactTimingHistory | null;
	try {
		raw = await readJsonIfExists<CompactTimingHistory>(
			fs,
			paths.compactTimingJson,
		);
	} catch {
		// Corrupt JSON must never break compaction — treat as no history.
		return emptyHistory();
	}
	if (!raw || !Array.isArray(raw.samples)) return emptyHistory();
	return {
		version: COMPACT_TIMING_VERSION,
		samples: raw.samples.filter(isValidSample),
	};
}

/**
 * Append one measured compaction, trim to the newest `COMPACT_TIMING_MAX_SAMPLES`,
 * and persist. Best-effort: a write failure is swallowed so a full disk (or a
 * read-only agent dir) can never break the compaction flow.
 */
export async function recordCompactTiming(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
	sample: CompactTimingSample,
): Promise<void> {
	if (!isValidSample(sample)) return;
	try {
		const history = await readCompactTimingHistory(fs, paths);
		const samples = [...history.samples, sample].slice(
			-COMPACT_TIMING_MAX_SAMPLES,
		);
		await fs.mkdirp(paths.projectDir);
		await writeJson(fs, paths.compactTimingJson, {
			version: COMPACT_TIMING_VERSION,
			samples,
		} satisfies CompactTimingHistory);
	} catch {
		// Non-fatal: the ETA indicator degrades to a timer, nothing else breaks.
	}
}
