/**
 * Read a required string field from a parsed tool params object, trimmed.
 *
 * Throws TypeError when the field is missing, not a string, or blank after
 * trimming. The "<key> must be a non-empty string." message is asserted by
 * several tool tests, so keep it stable.
 */
export function requiredString(
	params: Record<string, unknown>,
	key: string,
): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

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
