import { describe, expect, it } from "vitest";
import {
	type CompactTimingSample,
	estimateCompactionDuration,
	formatCompactIndicator,
	formatDurationShort,
	formatEtaLabel,
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
	it("shows a bare static label when there is no estimate", () => {
		const estimate = estimateCompactionDuration({
			samples: [],
			tokens: 118_000,
			model: "m",
		});
		const line = formatCompactIndicator({
			sizeLabel: "118k",
			reasonLabel: "/compact",
			estimate,
		});
		expect(line).toBe("Compacting 118k tok (/compact)…");
	});

	it("appends the predicted ETA as a fixed hint once history exists — no bar, no percent, no elapsed", () => {
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
			estimate,
		});
		// A static ETA hint, never an animated bar/percent — nothing that moves
		// mid-run and reflows the banner on every push.
		expect(line).toMatch(/^Compacting 100k tok \(context full\) · ~/);
		expect(line).not.toMatch(/[█░]/);
		expect(line).not.toMatch(/%/);
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

	it("predicts each size from its local neighbours, not one global line", () => {
		// A cheap cluster near ~50k (~5s) and one expensive far run at 200k (60s).
		// The local rate near 50k is ~0.1 ms/tok; near 200k it is ~0.3 ms/tok.
		const samples = [
			sample(50_000, 5_000),
			sample(55_000, 5_000),
			sample(60_000, 5_500),
			sample(200_000, 60_000),
		];
		const near = estimateCompactionDuration({
			samples,
			tokens: 57_000,
			model: "m",
		});
		const far = estimateCompactionDuration({
			samples,
			tokens: 190_000,
			model: "m",
		});
		// The near estimate tracks the cheap cluster; the far one tracks the 60s run.
		expect(near.etaMs).toBeLessThan(13_000);
		expect(far.etaMs).toBeGreaterThan(44_000);
		// Decisive locality: a single through-origin rate would force the ratio to
		// equal the token ratio (190/57 ≈ 3.33). A super-linear ratio can only come
		// from a per-size rate — proof the kernel localised the fit.
		expect(far.etaMs / near.etaMs).toBeGreaterThan(190 / 57);
	});

	it("widens the band for a small effective sample count", () => {
		// Two neighbours near the queried size (small effective N) → the band is
		// inflated past a bare ±rmse by the √(1+1/Nₑ) factor, so it is a real range.
		const e = estimateCompactionDuration({
			samples: [sample(90_000, 18_000), sample(110_000, 26_000)],
			tokens: 100_000,
			model: "m",
		});
		expect(e.hiMs).toBeGreaterThan(e.etaMs);
		expect(e.loMs).toBeLessThan(e.etaMs);
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
