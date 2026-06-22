/**
 * Narrow an unknown value (typically parsed JSON or a tool-result `details`
 * payload) to a plain object record.
 *
 * Returns an empty record for anything that is not a non-array object, so
 * callers can index fields without guarding every access. Arrays are rejected
 * deliberately: a JSON array is never a valid params/details object here, and
 * treating one as a record would expose numeric-index junk.
 */
export function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
