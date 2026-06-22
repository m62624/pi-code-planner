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
