// Planner compaction is output-aware: instead of leaning on Pi's fixed
// `reserveTokens` knob (which the extension cannot even read — the ExtensionContext
// exposes no compaction settings, only `getContextUsage()`), the planner computes
// its own compaction floor from live values. The reserve is driven by the model's
// real generation budget (`model.maxTokens`), guaranteeing there is always room to
// produce a full response — which is exactly what prevents the "length + output===0"
// context-overflow variant of the "maximum output token limit" stop.
//
// All knobs below are *ratios of live values* (context window / max output), so the
// math self-adapts across models and windows — correct on a tiny 32k local window
// and on a 1M window alike, without any fixed per-window preset.

// Share of the context window kept free for the next turn's unpredictable
// tool-calling output (tool results are injected mid-turn and Pi's reactive check
// cannot see them until the turn after).
export const PLANNER_TOOL_HEADROOM_RATIO = 0.06;

// Cap on how much of the window we hand to the output reserve, so a model that
// reports a pathologically large `maxTokens` (≈ the whole window) cannot push the
// floor to zero and cause compaction thrashing.
export const PLANNER_MAX_OUTPUT_RESERVE_RATIO = 0.25;

// Absolute floor for the output reserve, for models that report a tiny `maxTokens`.
export const PLANNER_MIN_OUTPUT_RESERVE = 4096;

// The computed compaction floor is clamped into this band (as a share of the
// window) so neither a huge `maxTokens` nor a tiny window drives it out of range.
export const PLANNER_MIN_FLOOR_RATIO = 0.5;
export const PLANNER_MAX_FLOOR_RATIO = 0.92;

// EWMA responsiveness for the per-turn context-growth tracker (velocity heuristic).
// The monitor pre-empts one typical turn before the floor; this weights how fast
// that estimate tracks recent turns. 0.3 keeps it responsive to a session that
// starts reading large files without letting one spike dominate the average.
export const PLANNER_TURN_GROWTH_ALPHA = 0.3;
