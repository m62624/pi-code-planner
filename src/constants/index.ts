// Project-wide constants, grouped by category. Existing `../constants` imports
// resolve here unchanged.

/** Identity of this extension, used for storage paths and registration. */
export const EXTENSION_NAME = "pi-code-planner";

/** On-disk schema version for persisted planner records. */
export const SCHEMA_VERSION = 1;

/** Milliseconds in one second. */
export const MS_PER_SECOND = 1_000;

/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000;

// Pi versions the planner has been tested against, as `major.minor` prefixes.
// Used only for an *advisory* self-check — never to block. A runtime Pi outside
// this range is flagged as "not validated" (informational), because a newer Pi is
// usually still compatible; the real compatibility signal is the SDK surface probe
// in `runtime/sdk-compat.ts`, not the version number.
// Each entry is a Pi minor line this planner build was actually run against in
// CI. The SDK watcher appends, never replaces: dropping a line that CI did pass
// would tell users on it that their Pi is "not validated" when it is. Prune by
// hand when a line is genuinely no longer supported.
export const PLANNER_KNOWN_GOOD_PI_VERSIONS: readonly string[] = [
	"0.80",
	"0.82",
	"0.83",
	"0.85",
];

/**
 * Default natural language for generated content (goal, title, commit
 * messages, etc.) when the user has not configured one. Mirrored by the
 * settings defaults in src/settings/schema.ts.
 */
export const DEFAULT_LANGUAGE = "English";
