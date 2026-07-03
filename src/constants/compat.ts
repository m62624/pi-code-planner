// Pi versions the planner has been tested against, as `major.minor` prefixes.
// Used only for an *advisory* self-check — never to block. A runtime Pi outside
// this range is flagged as "not validated" (informational), because a newer Pi is
// usually still compatible; the real compatibility signal is the SDK surface probe
// in `runtime/sdk-compat.ts`, not the version number.
export const PLANNER_KNOWN_GOOD_PI_VERSIONS: readonly string[] = ["0.80"];
