import { describe, expect, it } from "vitest";
import {
	type CompactTimingSample,
	compactionProgressFraction,
	estimateCompactionDuration,
	formatCompactIndicator,
	formatDurationShort,
	formatEtaLabel,
	renderProgressBar,
} from "./compact-eta";

function sample(
	tokens: number,
	ms: number,
	model: string | null = "m",
	at = 0,
): CompactTimingSample {
	return { tokens, ms, model, at };
}

describe("formatCompactIndicator", () => {
	it("shows a static label (no ticking seconds) when there is no estimate", () => {
		const estimate = estimateCompactionDuration({
			samples: [],
			tokens: 118_000,
			model: "m",
		});
		// The line must NOT depend on elapsedMs: a per-second counter would push a
		// full repaint every tick and flicker the widget. Same output at 12s / 40s.
		const at12 = formatCompactIndicator({
			sizeLabel: "118k",
			reasonLabel: "/compact",
			elapsedMs: 12_000,
			estimate,
		});
		const at40 = formatCompactIndicator({
			sizeLabel: "118k",
			reasonLabel: "/compact",
			elapsedMs: 40_000,
			estimate,
		});
		expect(at12).toBe("Compacting 118k tok (/compact)…");
		expect(at40).toBe(at12);
	});

	it("shows a filling bar, percent and ETA once history exists — no elapsed", () => {
		const estimate = estimateCompactionDuration({
			samples: [
				sample(50_000, 10_000),
				sample(100_000, 20_000),
				sample(150_000, 30_000),
			],
			tokens: 100_000,
			model: "m",
		});
		const line = formatCompactIndicator({
			sizeLabel: "100k",
			reasonLabel: "context full",
			elapsedMs: 5_000,
			estimate,
		});
		// bar + percent + ETA, but no `<elapsed> /` segment before the `~`.
		expect(line).toMatch(
			/^Compacting 100k tok \(context full\) [█░]+ \d+% · ~/,
		);
	});
});

describe("estimateCompactionDuration", () => {
	it("returns no estimate with empty history", () => {
		const e = estimateCompactionDuration({
			samples: [],
			tokens: 100_000,
			model: "m",
		});
		expect(e.hasEstimate).toBe(false);
		expect(e.reliability).toBe("none");
	});

	it("returns no estimate for a non-positive token count", () => {
		const e = estimateCompactionDuration({
			samples: [sample(100_000, 20_000)],
			tokens: 0,
			model: "m",
		});
		expect(e.hasEstimate).toBe(false);
	});

	it("ignores malformed samples", () => {
		const e = estimateCompactionDuration({
			samples: [
				sample(Number.NaN, 20_000),
				sample(100_000, -5),
				sample(0, 10_000),
			],
			tokens: 100_000,
			model: "m",
		});
		expect(e.hasEstimate).toBe(false);
	});

	it("uses the origin rate model from a single sample", () => {
		// 100k tokens took 20s → 200k should be ~40s.
		const e = estimateCompactionDuration({
			samples: [sample(100_000, 20_000)],
			tokens: 200_000,
			model: "m",
		});
		expect(e.fit).toBe("origin");
		expect(e.reliability).toBe("single");
		expect(e.etaMs).toBeCloseTo(40_000, -2);
		// Single-sample band is a wide heuristic, not a measured dispersion.
		expect(e.loMs).toBeLessThan(e.etaMs);
		expect(e.hiMs).toBeGreaterThan(e.etaMs);
		expect(e.cv).toBe(0);
	});

	it("fits an affine line (overhead + per-token) across sizes", () => {
		// T = 5000 + 0.1·x : 50k→10s, 100k→15s, 150k→20s.
		const e = estimateCompactionDuration({
			samples: [
				sample(50_000, 10_000),
				sample(100_000, 15_000),
				sample(150_000, 20_000),
			],
			tokens: 200_000,
			model: "m",
		});
		expect(e.fit).toBe("affine");
		expect(e.etaMs).toBeCloseTo(25_000, -2);
		expect(e.reliability).toBe("stable");
		expect(e.cv).toBeLessThan(0.05);
	});

	it("flags a noisy estimate when durations swing at similar sizes", () => {
		const e = estimateCompactionDuration({
			samples: [
				sample(100_000, 10_000),
				sample(102_000, 40_000),
				sample(98_000, 12_000),
				sample(101_000, 38_000),
			],
			tokens: 100_000,
			model: "m",
		});
		expect(e.reliability).toBe("noisy");
		expect(e.cv).toBeGreaterThan(0.25);
		// The band must be a real range for a noisy estimate.
		expect(e.hiMs - e.loMs).toBeGreaterThan(0);
	});

	it("falls back to the origin model when x has no spread", () => {
		const e = estimateCompactionDuration({
			samples: [sample(100_000, 20_000), sample(100_000, 22_000)],
			tokens: 100_000,
			model: "m",
		});
		expect(e.fit).toBe("origin");
		expect(e.etaMs).toBeGreaterThan(0);
	});

	it("rejects an unphysical negative-overhead affine fit", () => {
		// A steep line through these points implies a < 0; must not be used.
		const e = estimateCompactionDuration({
			samples: [
				sample(100_000, 5_000),
				sample(200_000, 30_000),
				sample(300_000, 55_000),
			],
			tokens: 50_000,
			model: "m",
		});
		// Whatever model is chosen, a small input can never predict a negative time.
		expect(e.etaMs).toBeGreaterThan(0);
	});

	it("weights recent samples more than old ones", () => {
		// Old runs were slow (40s/100k), the last several are fast (10s/100k).
		const samples: CompactTimingSample[] = [
			sample(100_000, 40_000),
			sample(100_000, 40_000),
			sample(100_000, 10_000),
			sample(100_000, 10_000),
			sample(100_000, 10_000),
		];
		const e = estimateCompactionDuration({
			samples,
			tokens: 100_000,
			model: "m",
		});
		// Recency-weighted mean must sit clearly below the naïve 22s average,
		// because the three fast recent runs outweigh the two slow old ones.
		expect(e.etaMs).toBeLessThan(20_000);
	});

	it("down-weights samples from a different model", () => {
		// One same-model fast sample vs several slow other-model samples.
		const samples: CompactTimingSample[] = [
			sample(100_000, 60_000, "other"),
			sample(100_000, 60_000, "other"),
			sample(100_000, 10_000, "m"),
		];
		const e = estimateCompactionDuration({
			samples,
			tokens: 100_000,
			model: "m",
		});
		// The same-model sample (plus recency) should pull the estimate toward 10s.
		expect(e.etaMs).toBeLessThan(30_000);
	});

	it("floors sub-second predictions", () => {
		const e = estimateCompactionDuration({
			samples: [sample(100_000, 20_000)],
			tokens: 1,
			model: "m",
		});
		expect(e.etaMs).toBeGreaterThanOrEqual(800);
	});
});

describe("compactionProgressFraction", () => {
	it("is zero at start and rises monotonically", () => {
		const eta = 20_000;
		const at0 = compactionProgressFraction({
			elapsedMs: 0,
			etaMs: eta,
			reliability: "stable",
		});
		const at5 = compactionProgressFraction({
			elapsedMs: 5_000,
			etaMs: eta,
			reliability: "stable",
		});
		const at10 = compactionProgressFraction({
			elapsedMs: 10_000,
			etaMs: eta,
			reliability: "stable",
		});
		expect(at0).toBe(0);
		expect(at5).toBeGreaterThan(at0);
		expect(at10).toBeGreaterThan(at5);
	});

	it("reaches the fill target exactly at the ETA", () => {
		const p = compactionProgressFraction({
			elapsedMs: 20_000,
			etaMs: 20_000,
			reliability: "stable",
		});
		expect(p).toBeCloseTo(0.9, 5);
	});

	it("never reaches 100% even long past the ETA", () => {
		const p = compactionProgressFraction({
			elapsedMs: 10_000_000,
			etaMs: 20_000,
			reliability: "stable",
		});
		expect(p).toBeLessThan(1);
		expect(p).toBeLessThanOrEqual(0.99);
	});

	it("fills more conservatively when noisy than when stable", () => {
		const stable = compactionProgressFraction({
			elapsedMs: 20_000,
			etaMs: 20_000,
			reliability: "stable",
		});
		const noisy = compactionProgressFraction({
			elapsedMs: 20_000,
			etaMs: 20_000,
			reliability: "noisy",
		});
		expect(noisy).toBeLessThan(stable);
	});

	it("is zero for a 'none' reliability", () => {
		expect(
			compactionProgressFraction({
				elapsedMs: 5_000,
				etaMs: 0,
				reliability: "none",
			}),
		).toBe(0);
	});
});

describe("renderProgressBar", () => {
	it("renders empty and full bars", () => {
		expect(renderProgressBar(0, 10)).toBe("░░░░░░░░░░");
		expect(renderProgressBar(1, 10)).toBe("██████████");
	});

	it("renders a partial bar", () => {
		expect(renderProgressBar(0.5, 10)).toBe("█████░░░░░");
	});

	it("clamps out-of-range fractions", () => {
		expect(renderProgressBar(-1, 4)).toBe("░░░░");
		expect(renderProgressBar(2, 4)).toBe("████");
	});
});

describe("formatDurationShort", () => {
	it("formats seconds and minutes", () => {
		expect(formatDurationShort(8_000)).toBe("8s");
		expect(formatDurationShort(45_400)).toBe("45s");
		expect(formatDurationShort(90_000)).toBe("1m30s");
		// Past a minute, minutes and seconds always show together (zero-padded);
		// a whole-minute duration keeps `00s` rather than collapsing to `2m`.
		expect(formatDurationShort(65_000)).toBe("1m05s");
		expect(formatDurationShort(120_000)).toBe("2m00s");
	});
});

describe("formatEtaLabel", () => {
	it("is empty without an estimate", () => {
		expect(
			formatEtaLabel(
				estimateCompactionDuration({ samples: [], tokens: 1, model: null }),
			),
		).toBe("");
	});

	it("shows a point for a stable estimate and a range for a noisy one", () => {
		const stable = estimateCompactionDuration({
			samples: [
				sample(50_000, 10_000),
				sample(100_000, 15_000),
				sample(150_000, 20_000),
			],
			tokens: 100_000,
			model: "m",
		});
		expect(formatEtaLabel(stable)).toMatch(/^~\d+s$/);

		const noisy = estimateCompactionDuration({
			samples: [
				sample(100_000, 10_000),
				sample(102_000, 40_000),
				sample(98_000, 12_000),
				sample(101_000, 38_000),
			],
			tokens: 100_000,
			model: "m",
		});
		expect(formatEtaLabel(noisy)).toContain("–");
	});
});
