/**
 * Empirical ETA model for the planner compaction indicator.
 *
 * The Pi SDK never streams summary generation to extensions, so a *true* percent
 * progress bar is impossible from live data alone. Instead we learn it: every
 * completed compaction is one observation `(tokensBefore, durationMs, model)`,
 * and from the last N observations of a project we predict how long the *next*
 * compaction of a given size will take, then drive an honest, asymptotic bar
 * from `elapsed / predicted`.
 *
 * Everything here is pure so the math is unit-tested without the SDK or fs. The
 * I/O (loading / persisting history per project) lives in
 * `storage/compact-timing-store.ts`, and the wiring lives in `index.ts`.
 *
 * ## The model
 *
 * Compaction cost is well approximated by an affine function of the input size:
 *
 *     T(x) = a + b·x
 *
 * where `x = tokensBefore`, `a` is fixed overhead (request round-trip + the
 * roughly-constant cost of generating a bounded structured summary) and `b` is
 * seconds-per-input-token (prompt processing). We fit `a, b` by **weighted least
 * squares** over history, weighting each sample by:
 *
 *   - **recency** — `RECENCY_DECAY^age` (age 0 = newest), so the estimate tracks
 *     drift (a machine warming up, changing load) instead of averaging stale runs;
 *   - **model match** — same model as the current one keeps full weight, a
 *     different model is down-weighted, because throughput differs wildly between
 *     a local model and a cloud one.
 *
 * With too few points, or points that share (nearly) the same `x` — where a line
 * has no stable slope — we fall back to a through-origin rate model `T(x) = b·x`,
 * which is stable from a single observation (`b = ms/tokens`).
 *
 * ## Does the time vary a lot? (variance)
 *
 * We do not just emit a point estimate. We compute the weighted RMSE of the fit
 * residuals and its coefficient of variation `cv = rmse / T̂`. That is the direct
 * answer to "does compaction time swing across measurements": a high `cv` marks
 * the estimate **noisy**, which (a) widens the displayed band to a range and
 * (b) lowers the bar's fill target so it is less likely to overrun.
 */

export interface CompactTimingSample {
	/** `tokensBefore` — the context size that was summarized. */
	tokens: number;
	/** Measured wall-clock duration of the compaction, in milliseconds. */
	ms: number;
	/** Model id in effect, or null when unknown. */
	model: string | null;
	/** Epoch ms when the sample was recorded (unused by the math, kept for audit). */
	at: number;
}

export type CompactEtaReliability = "none" | "single" | "noisy" | "stable";

export interface CompactEtaEstimate {
	/** False when there is no usable history: caller should show a bare timer. */
	hasEstimate: boolean;
	/** Point prediction T̂(x) in ms, floored so a tiny fit never yields ~0. */
	etaMs: number;
	/** Lower / upper band (≈ ±1 weighted RMSE, widened for a single sample). */
	loMs: number;
	hiMs: number;
	/** Coefficient of variation of the fit residuals (0 when not computable). */
	cv: number;
	reliability: CompactEtaReliability;
	/** How many valid samples fed the fit. */
	sampleCount: number;
	/** Which model was used, for debugging / tests. */
	fit: "none" | "origin" | "affine";
}

// Newer samples dominate: weight halves roughly every ~4 samples (0.85^4 ≈ 0.52).
const RECENCY_DECAY = 0.85;
// A sample from a different model still carries information (overhead is similar)
// but its throughput is not ours, so it is heavily discounted.
const MODEL_MISMATCH_WEIGHT = 0.25;
// Above this residual coefficient of variation the estimate is "noisy".
const CV_STABLE = 0.25;
// A single fit whose slope is this flat (per-token) is treated as degenerate and
// handled by the origin model instead of the affine one.
const MIN_SPREAD = 1e-9;
// Never predict a sub-second compaction — the round-trip alone costs more.
const ETA_FLOOR_MS = 800;
// The bar creeps from its ETA target toward this cap but never reaches 100%
// until the real completion event fires.
const PROGRESS_CAP = 0.99;
// Time-constant (in units of ETA) for the post-ETA asymptotic creep.
const PROGRESS_CREEP = 0.6;

// Bar fill reached exactly at the predicted ETA, chosen by confidence: a stable
// estimate fills close to full, a noisy or single-sample one stays conservative
// so an overrun is less jarring.
const FILL_AT_ETA: Record<Exclude<CompactEtaReliability, "none">, number> = {
	stable: 0.9,
	noisy: 0.8,
	single: 0.75,
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function noEstimate(): CompactEtaEstimate {
	return {
		hasEstimate: false,
		etaMs: 0,
		loMs: 0,
		hiMs: 0,
		cv: 0,
		reliability: "none",
		sampleCount: 0,
		fit: "none",
	};
}

/**
 * Weight each sample by recency and model match. `samples` must be ordered
 * oldest → newest (as persisted), so index `n-1` is the most recent.
 */
function computeWeights(
	samples: readonly CompactTimingSample[],
	model: string | null,
): number[] {
	const n = samples.length;
	return samples.map((sample, index) => {
		const age = n - 1 - index;
		const recency = RECENCY_DECAY ** age;
		const modelMatch =
			model === null || sample.model === null
				? 1
				: sample.model === model
					? 1
					: MODEL_MISMATCH_WEIGHT;
		return recency * modelMatch;
	});
}

/**
 * Predict compaction duration for `tokens` from prior samples. Pure; safe on
 * empty / malformed history (returns `hasEstimate: false`).
 */
export function estimateCompactionDuration(input: {
	samples: readonly CompactTimingSample[];
	tokens: number;
	model: string | null;
}): CompactEtaEstimate {
	const clean = input.samples.filter(
		(s) =>
			Number.isFinite(s.tokens) &&
			s.tokens > 0 &&
			Number.isFinite(s.ms) &&
			s.ms > 0,
	);
	const x = input.tokens;
	if (clean.length === 0 || !Number.isFinite(x) || x <= 0) {
		return noEstimate();
	}

	const w = computeWeights(clean, input.model);
	const W = w.reduce((acc, wi) => acc + wi, 0);
	if (W <= 0) return noEstimate();

	// Weighted means.
	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < clean.length; i++) {
		sumX += w[i] * clean[i].tokens;
		sumY += w[i] * clean[i].ms;
	}
	const xBar = sumX / W;
	const yBar = sumY / W;

	// Weighted covariance / variance of x for the affine fit.
	let sxx = 0;
	let sxy = 0;
	let sumWXX = 0;
	let sumWXY = 0;
	for (let i = 0; i < clean.length; i++) {
		const dx = clean[i].tokens - xBar;
		const dy = clean[i].ms - yBar;
		sxx += w[i] * dx * dx;
		sxy += w[i] * dx * dy;
		sumWXX += w[i] * clean[i].tokens * clean[i].tokens;
		sumWXY += w[i] * clean[i].tokens * clean[i].ms;
	}

	// Affine fit is only trustworthy with ≥2 samples, real x-spread, a positive
	// slope (more tokens must not be *faster*) and non-negative overhead (a
	// negative intercept is unphysical and blows up small-x predictions).
	let fit: "origin" | "affine";
	let predict: (t: number) => number;
	const relXSpread = sxx / (W * (xBar * xBar || 1));
	if (clean.length >= 2 && relXSpread > MIN_SPREAD) {
		const b = sxy / sxx;
		const a = yBar - b * xBar;
		if (b > 0 && a >= 0) {
			fit = "affine";
			predict = (t) => a + b * t;
		} else {
			const b0 = sumWXY / sumWXX;
			fit = "origin";
			predict = (t) => b0 * t;
		}
	} else {
		const b0 = sumWXY / sumWXX;
		fit = "origin";
		predict = (t) => b0 * t;
	}

	const rawEta = predict(x);
	// A degenerate fit can still go non-positive; guard before it reaches the UI.
	const point = Number.isFinite(rawEta) && rawEta > 0 ? rawEta : ETA_FLOOR_MS;

	// Weighted RMSE of residuals against the chosen model → dispersion.
	let resSq = 0;
	for (let i = 0; i < clean.length; i++) {
		const r = clean[i].ms - predict(clean[i].tokens);
		resSq += w[i] * r * r;
	}
	const rmse = Math.sqrt(resSq / W);

	const etaMs = Math.max(ETA_FLOOR_MS, point);

	let reliability: CompactEtaReliability;
	let loMs: number;
	let hiMs: number;
	let cv: number;
	if (clean.length === 1) {
		// No dispersion is observable from one point; show a wide heuristic band
		// and flag the estimate as provisional rather than pretending precision.
		reliability = "single";
		cv = 0;
		loMs = Math.max(ETA_FLOOR_MS, etaMs * 0.7);
		hiMs = etaMs * 1.4;
	} else {
		cv = etaMs > 0 ? rmse / etaMs : 0;
		reliability = cv > CV_STABLE ? "noisy" : "stable";
		loMs = Math.max(ETA_FLOOR_MS, etaMs - rmse);
		hiMs = etaMs + rmse;
	}

	return {
		hasEstimate: true,
		etaMs,
		loMs,
		hiMs,
		cv,
		reliability,
		sampleCount: clean.length,
		fit,
	};
}

/**
 * Fraction (0..CAP) to fill the bar after `elapsedMs`, given the predicted ETA.
 *
 * Honest and monotonic: it fills linearly to `FILL_AT_ETA[reliability]` at
 * exactly the ETA, then creeps asymptotically toward — but never reaches —
 * `PROGRESS_CAP`. The real completion event is what shows 100%; the bar itself
 * never claims to be done.
 */
export function compactionProgressFraction(input: {
	elapsedMs: number;
	etaMs: number;
	reliability: CompactEtaReliability;
}): number {
	if (!(input.etaMs > 0) || input.reliability === "none") return 0;
	const target = FILL_AT_ETA[input.reliability];
	const f = Math.max(0, input.elapsedMs) / input.etaMs;
	const p =
		f <= 1
			? target * f
			: target +
				(PROGRESS_CAP - target) * (1 - Math.exp(-(f - 1) / PROGRESS_CREEP));
	return clamp(p, 0, PROGRESS_CAP);
}

/** Render a fixed-width block bar for the given fraction. */
export function renderProgressBar(fraction: number, width = 10): string {
	const filled = clamp(Math.round(fraction * width), 0, width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Short human duration. Below a minute it is just seconds (`8s`, `45s`). At or
 * above a minute it always shows minutes AND seconds together, seconds
 * zero-padded (`1m05s`, `2m00s`) — never a bare `125s`, and never a `2m` that
 * silently drops the seconds, so a running timer reads cleanly the whole way.
 */
export function formatDurationShort(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Compose the one-line compaction indicator. With learned history it shows an
 * honest, asymptotic bar (`… ██████░░░░ 62% · 18s / ~30s`); with no history yet
 * it is a bare running timer. Pure so the format is unit-tested without the SDK,
 * and shared by both the top widget and any other surface that shows the run.
 */
export function formatCompactIndicator(input: {
	sizeLabel: string;
	reasonLabel: string;
	elapsedMs: number;
	estimate: CompactEtaEstimate;
}): string {
	const elapsed = formatDurationShort(input.elapsedMs);
	if (!input.estimate.hasEstimate) {
		return `Compacting ${input.sizeLabel} tok (${input.reasonLabel})… ${elapsed}`;
	}
	const frac = compactionProgressFraction({
		elapsedMs: input.elapsedMs,
		etaMs: input.estimate.etaMs,
		reliability: input.estimate.reliability,
	});
	const bar = renderProgressBar(frac);
	const pct = Math.round(frac * 100);
	return `Compacting ${input.sizeLabel} tok (${input.reasonLabel}) ${bar} ${pct}% · ${elapsed} / ${formatEtaLabel(input.estimate)}`;
}

/**
 * Human ETA label. A stable / single estimate shows a point (`~24s`); a noisy
 * one shows the band as a range (`~20–40s`) so the uncertainty is visible.
 */
export function formatEtaLabel(estimate: CompactEtaEstimate): string {
	if (!estimate.hasEstimate) return "";
	if (estimate.reliability === "noisy") {
		return `~${formatDurationShort(estimate.loMs)}–${formatDurationShort(estimate.hiMs)}`;
	}
	return `~${formatDurationShort(estimate.etaMs)}`;
}
