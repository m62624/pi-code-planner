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

/**
 * Like {@link errorMessage}, but appends a thrown value's `stderr` when present.
 *
 * Git failures (`GitCommandError`) carry the real reason — "Merge conflict in
 * .gitignore", "branch already exists", etc. — on `stderr`, while `.message` is
 * only the failed command. Use this when surfacing git failures to a human so
 * the actual cause is not hidden behind the bare command.
 */
export function gitErrorMessage(error: unknown): string {
	const base = errorMessage(error);
	if (
		error &&
		typeof error === "object" &&
		"stderr" in error &&
		typeof (error as { stderr: unknown }).stderr === "string"
	) {
		const stderr = (error as { stderr: string }).stderr.trim();
		if (stderr) {
			return `${base}\n${stderr}`;
		}
	}
	return base;
}
