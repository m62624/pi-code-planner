import type { ReasoningFuel } from "./reasoning-fuel";

/**
 * The tone ladder — the ONLY effect a fuel level has. Fuel never blocks; it
 * only changes how loudly the directive speaks:
 *
 *   null        → silent (nothing warrants the engine here)
 *   ≥ 70        → quiet: a single "Reasoning fuel: NN" line
 *   30–69       → names the top deficit and one cheap next move
 *   < 30 or R>0 → directing: names the deficit and prescribes a different move,
 *                 with a "what's needed now / not needed now" pair
 *
 * The texts are templated (signal → text), never generative. A deficit is only
 * ever named from the planner's own accounting — warranted web left unmodeled,
 * stale anchors, gate thrash — never from anything read out of the engine.
 */

export interface ReasoningDirectiveContext {
	/**
	 * What the web is made of at this step, as a plural noun the directive can
	 * drop into a sentence — e.g. "branches", "spec constraints", "shared task
	 * surfaces". Only used when there is unmet web to name.
	 */
	webNoun: string;
	/**
	 * The reason move to prescribe, e.g. "planner_reason". Named in the low-fuel
	 * directing tone so the model knows exactly which tool to reach for.
	 */
	reasonTool: string;
}

/** The deficit fragments this fuel names, most-actionable first. */
function deficitFragments(
	fuel: ReasoningFuel,
	context: ReasoningDirectiveContext,
): string[] {
	const fragments: string[] = [];
	if (fuel.unmet > 0) {
		fragments.push(
			`${fuel.unmet} ${context.webNoun} still unmodeled — run them through ${context.reasonTool}`,
		);
	}
	if (fuel.stale > 0) {
		fragments.push(
			`${fuel.stale} stale anchor${fuel.stale === 1 ? "" : "s"}: a source changed since you asserted it — re-assert or retract`,
		);
	}
	if (fuel.friction > 0) {
		fragments.push(
			"you re-ran a gate with the same verdict and no change — that is thrash, not progress; change the input or move on",
		);
	}
	return fragments;
}

/**
 * Render the directive line(s) for a computed fuel, or "" when fuel is null
 * (nothing here warrants the engine — stay silent).
 */
export function renderReasoningDirective(
	fuel: ReasoningFuel,
	context: ReasoningDirectiveContext,
): string {
	if (fuel.fuel === null) return "";

	const level = fuel.fuel;
	const fragments = deficitFragments(fuel, context);

	// Any friction (a named thinking pathology) forces the directing tone even at
	// otherwise-high fuel — the signal must be surfaced by name.
	const directing = fuel.friction > 0 || level < 30;
	if (!directing) {
		if (level >= 70) {
			return `Reasoning fuel: ${level}`;
		}
		const top = fragments[0] ?? "some web is unmodeled";
		return `Reasoning fuel: ${level} — ${top}.`;
	}

	// The directing tone. Name every deficit, then say what is and is not the
	// move now.
	const named = fragments.length > 0 ? fragments.join("; ") : "the web is thin";
	const needed =
		fuel.unmet > 0
			? `model the remaining ${context.webNoun} with ${context.reasonTool}`
			: fuel.stale > 0
				? "reconcile the stale anchors, then re-check"
				: "change what you feed the engine before re-checking";
	return [
		`Reasoning fuel: ${level} — ${named}.`,
		`What's needed now: ${needed}.`,
		"What's NOT needed now: another identical run — it will not move the verdict.",
	].join("\n");
}
