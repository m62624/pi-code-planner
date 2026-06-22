/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * `catch` clauses receive `unknown`, but the vast majority of throwables are
 * `Error` instances whose `.message` is the useful text. Everything else is
 * coerced with `String()` so the caller always gets a printable string.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
