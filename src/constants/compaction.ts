// Planner-controlled compaction fires one reserve-window *earlier* than Pi's
// built-in auto-compaction so the two never race: Pi auto-compacts when
// `tokens > contextWindow - reserveTokens` (multiplier 1), so using a larger
// multiplier here lowers our floor and makes the planner compaction trigger
// first — at a natural stage boundary, with planner-preserving instructions —
// keeping context under Pi's threshold. The value scales with the context
// window, so it stays correct on a tiny 32k local window and on a 1M window
// alike (a fixed percentage would not).
export const PLANNER_COMPACT_RESERVE_MULTIPLIER = 1.5;
