import type { TaskRecord } from "../storage/schema";
import type { SpecRecord } from "../storage/spec-store";

/**
 * Reasoning fuel: a deterministic scalar that pulls the model toward the
 * elenchus engine where a genuine web of interacting conditions is on the
 * table, and stays neutral where there is none. It is computed entirely from
 * the planner's OWN artifacts (behavior-board branches, spec constraints, the
 * task graph) and its own records (the last-check verdict enum, its repeat
 * counter, the compiler's stale-anchor sweep). It never reads a field of the
 * engine's report beyond the verdict code — that is the whole point of the
 * redesign, and the guard against re-coupling to the engine's private JSON.
 *
 * The shape of the incentive is a 2×2:
 *
 *   |                    | no web (W=0)      | web (W>0)                 |
 *   | ran elenchus       | null (neutral)    | ~100 (quiet, good path)   |
 *   | skipped elenchus   | null (correct)    | low fuel (nudge: lazy)    |
 *
 * Running the engine where there is no web earns nothing (W caps coverage) and
 * costs nothing (fuel stays null): no ritual incentive, no punishment.
 * Skipping it where a web exists depletes fuel in proportion to the web left
 * unmodeled. Fuel never blocks anything — its only effect is the tone of the
 * directive the status/tool-tail renders. The hard floors stay on named
 * terminal defects (a CONFLICT verdict, an un-CONSISTENT gate), never on fuel.
 */

export interface ReasoningFuelInput {
	/** Warranted web: how much interacting-condition structure is on the table. */
	warrantedWeb: number;
	/** How much of the web the model actually ran through the engine (0..W). */
	coverage: number;
	/** Stale anchors scoped to this step, from the planner's own hash sweep. */
	stale: number;
	/** Behavioral friction (gate thrash), from the planner's own records. */
	friction: number;
}

export interface ReasoningFuel {
	/**
	 * 0..100, or null when there is no web, no stale anchor, and no friction —
	 * i.e. nothing here warrants the engine, so the directive stays silent.
	 */
	fuel: number | null;
	warrantedWeb: number;
	coverage: number;
	/** Warranted web the model did not run through the engine. */
	unmet: number;
	stale: number;
	friction: number;
}

/**
 * The core math. Deterministic, pure, and blind to the engine's report:
 *
 *   unmet   = max(0, W - coverage)
 *   deficit = unmet + stale + friction
 *   fuel    = round(100 * (1 - deficit / (W + stale + friction + 1)))
 *
 * The `+1` in the denominator gives a gradient (one unmet unit of a 1-web step
 * lands at 50, of a 4-web step at 20) and guards the divide. Coverage is capped
 * at the warranted web so a run on a no-web step can never manufacture credit.
 */
export function computeReasoningFuel(input: ReasoningFuelInput): ReasoningFuel {
	const warrantedWeb = Math.max(0, Math.trunc(input.warrantedWeb));
	const coverage = Math.min(
		warrantedWeb,
		Math.max(0, Math.trunc(input.coverage)),
	);
	const stale = Math.max(0, Math.trunc(input.stale));
	const friction = Math.max(0, Math.trunc(input.friction));
	const unmet = warrantedWeb - coverage;
	if (warrantedWeb === 0 && stale === 0 && friction === 0) {
		return { fuel: null, warrantedWeb, coverage, unmet, stale, friction };
	}
	const deficit = unmet + stale + friction;
	const denominator = warrantedWeb + stale + friction + 1;
	const fuel = Math.round(100 * (1 - deficit / denominator));
	return { fuel, warrantedWeb, coverage, unmet, stale, friction };
}

// ---------------------------------------------------------------------------
// demand collectors — warranted web, from the planner's own artifacts
// ---------------------------------------------------------------------------

/**
 * The web an execution step (write_tdd_plan / contract_check) warrants: the
 * number of branches the active task declared on its behavior board. This is
 * the strongest, already-proven demand signal — the branch-contract in
 * elenchus-tools already forces a checked program to model every one of them.
 */
export function warrantedWebFromBranches(
	branches: readonly { id: string }[],
): number {
	return branches.length;
}

/**
 * The web a consistency_check step warrants: the number of interacting
 * constraints the model itself declared in the spec. Zero constraints ⇒ no
 * declared interaction ⇒ no pressure; we never invent a web the artifacts do
 * not show.
 */
export function warrantedWebFromSpecConstraints(spec: SpecRecord): number {
	return spec.constraints.length;
}

/**
 * The web a doubt_review step warrants: the number of surfaces (scope
 * entries — files/areas) that two or more tasks share. Shared surfaces are
 * where cross-task interactions actually live; a plan whose tasks touch
 * disjoint surfaces has no cross-task web to check.
 */
export function sharedTaskSurfaces(tasks: readonly TaskRecord[]): number {
	const counts = new Map<string, number>();
	for (const task of tasks) {
		for (const entry of task.scope ?? []) {
			const key = entry.trim();
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	let shared = 0;
	for (const count of counts.values()) {
		if (count >= 2) shared += 1;
	}
	return shared;
}

// ---------------------------------------------------------------------------
// engagement + friction — from the planner's own last-check record
// ---------------------------------------------------------------------------

/**
 * The minimal shape of the last-check record the fuel layer reads. Structurally
 * a subset of {@link import("./elenchus-tools").ElenchusLastCheckRecord}; kept
 * local so the fuel math depends on no store and stays trivially testable.
 */
export interface FuelLastCheck {
	stage: string;
	step: string;
	outcome: string;
	/** Set on gate runs (compiler-authored); a model-authored run leaves it unset. */
	gate?: string;
	/** How many times in a row the same gate re-ran with the same verdict + source. */
	repeat?: number;
}

/**
 * Verdicts that count as the model having engaged the engine. CONFLICT is
 * included on purpose: surfacing a real contradiction is honest engagement, so
 * fuel does not punish it — the existing CONFLICT-block on finish_step is what
 * keeps the step from advancing until the contradiction is resolved.
 */
export const QUALIFYING_VERDICTS: ReadonlySet<string> = new Set([
	"CONSISTENT",
	"WARNING",
	"UNDERDETERMINED",
	"CONFLICT",
]);

/**
 * Coverage from the last check: the full warranted web if a *model-authored*
 * qualifying run happened on this very step, else 0. Gate runs (compiler
 * -authored, `gate` set) are the mechanical floor, not the model's own
 * reasoning about the web, so they never grant coverage. A check recorded on a
 * different step is stale for this one — coverage resets when the step changes.
 */
export function coverageFromLastCheck(input: {
	warrantedWeb: number;
	lastCheck: FuelLastCheck | null;
	stage: string;
	step: string;
}): number {
	const { lastCheck } = input;
	if (!lastCheck) return 0;
	if (lastCheck.gate !== undefined) return 0;
	if (lastCheck.stage !== input.stage || lastCheck.step !== input.step) {
		return 0;
	}
	return QUALIFYING_VERDICTS.has(lastCheck.outcome)
		? Math.max(0, Math.trunc(input.warrantedWeb))
		: 0;
}

/**
 * Gate-thrash friction: 1 when the latest gate re-ran two or more times with
 * the same verdict AND the same source hash (its `repeat` counter reached 2),
 * else 0. A legitimate re-run after a real change resets the counter, so it
 * never fires on progress.
 */
export function frictionFromLastCheck(lastCheck: FuelLastCheck | null): number {
	return lastCheck && (lastCheck.repeat ?? 0) >= 2 ? 1 : 0;
}
