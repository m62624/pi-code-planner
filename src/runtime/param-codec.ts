import { asObject } from "./params";

/**
 * A tiny polymorphic codec layer for parsing tool arguments.
 *
 * Every tool used to hand-roll its own `requiredString`/`stringArray`/enum
 * checks, each throwing a bare `TypeError("<key> must be …")`. The shared error
 * boundary (installPlannerToolErrorBoundary) turned the FIRST such throw into a
 * result, so the model saw one field at a time, never the value it actually
 * sent, and never a hint. For a small local model that is the difference
 * between self-correcting and retrying the same broken call forever.
 *
 * Here a `ParamCodec<T>` is one interface with many implementations (string,
 * array, enum, int-range, …). `parseParams` composes them into a schema, parses
 * every field, and aggregates all failures into ONE message that names the
 * tool, each bad field, what was expected, and what was received. Codecs return
 * a discriminated-union result rather than throwing, so the hot path has no
 * exceptions and callers stay total.
 */

export type ParamResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

export interface ParamCodec<T> {
	/** Human-readable description of the accepted shape, e.g. "a non-empty string". */
	readonly expected: string;
	parse(raw: unknown): ParamResult<T>;
}

const MAX_RECEIVED_PREVIEW = 60;

/** A short, safe description of what the caller actually passed, for error text. */
export function describeReceived(raw: unknown): string {
	if (raw === undefined) return "nothing (field missing)";
	if (raw === null) return "null";
	if (Array.isArray(raw)) return `an array (length ${raw.length})`;
	const type = typeof raw;
	if (type === "string") {
		const text = raw as string;
		const preview =
			text.length > MAX_RECEIVED_PREVIEW
				? `${text.slice(0, MAX_RECEIVED_PREVIEW)}…`
				: text;
		return `a string (${JSON.stringify(preview)})`;
	}
	if (type === "number" || type === "boolean" || type === "bigint") {
		return `a ${type} (${String(raw)})`;
	}
	return `a ${type}`;
}

function fail<T>(
	expected: string,
	raw: unknown,
	hint?: string,
): ParamResult<T> {
	const base = `expected ${expected}, received ${describeReceived(raw)}.`;
	return { ok: false, error: hint ? `${base} ${hint}` : base };
}

function ok<T>(value: T): ParamResult<T> {
	return { ok: true, value };
}

/** A trimmed, non-empty string. */
export function trimmedString(hint?: string): ParamCodec<string> {
	const expected = "a non-empty string";
	return {
		expected,
		parse(raw) {
			if (typeof raw !== "string" || raw.trim().length === 0) {
				return fail(expected, raw, hint);
			}
			return ok(raw.trim());
		},
	};
}

/** A trimmed string, or `null` when the field is absent/blank. */
export function optionalString(): ParamCodec<string | null> {
	const expected = "a string or nothing";
	return {
		expected,
		parse(raw) {
			if (raw === undefined || raw === null) return ok(null);
			if (typeof raw !== "string") return fail(expected, raw);
			const trimmed = raw.trim();
			return ok(trimmed.length > 0 ? trimmed : null);
		},
	};
}

/** An array of strings, trimmed, blanks dropped, de-duplicated (order kept). */
export function stringArray(hint?: string): ParamCodec<string[]> {
	const expected = "an array of strings";
	return {
		expected,
		parse(raw) {
			if (raw === undefined || raw === null) return ok([]);
			return cleanStringArray(raw, expected, false, hint);
		},
	};
}

/** Like {@link stringArray}, but must hold at least one non-blank entry. */
export function nonEmptyStringArray(hint?: string): ParamCodec<string[]> {
	const expected = "a non-empty array of strings";
	return {
		expected,
		parse(raw) {
			return cleanStringArray(raw, expected, true, hint);
		},
	};
}

function cleanStringArray(
	raw: unknown,
	expected: string,
	requireNonEmpty: boolean,
	hint?: string,
): ParamResult<string[]> {
	if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
		return fail(
			expected,
			raw,
			hint ?? "Pass each item as its own string element.",
		);
	}
	const cleaned = [
		...new Set(
			raw.map((item) => item.trim()).filter((item) => item.length > 0),
		),
	];
	if (requireNonEmpty && cleaned.length === 0) {
		return fail(expected, raw, hint ?? "Provide at least one non-empty entry.");
	}
	return ok(cleaned);
}

/** One of a fixed set of string literals. */
export function enumOf<const T extends string>(
	values: readonly T[],
): ParamCodec<T> {
	const expected = `one of: ${values.join(", ")}`;
	return {
		expected,
		parse(raw) {
			if (
				typeof raw === "string" &&
				(values as readonly string[]).includes(raw)
			) {
				return ok(raw as T);
			}
			return fail(expected, raw);
		},
	};
}

/** A boolean. */
export function boolean(): ParamCodec<boolean> {
	const expected = "a boolean (true or false)";
	return {
		expected,
		parse(raw) {
			return typeof raw === "boolean" ? ok(raw) : fail(expected, raw);
		},
	};
}

/** An integer within `[min, max]` (inclusive). */
export function intRange(min: number, max: number): ParamCodec<number> {
	const expected = `an integer from ${min} to ${max}`;
	return {
		expected,
		parse(raw) {
			if (typeof raw !== "number" || !Number.isInteger(raw)) {
				return fail(expected, raw);
			}
			if (raw < min || raw > max) return fail(expected, raw);
			return ok(raw);
		},
	};
}

export type ParamSchema = Record<string, ParamCodec<unknown>>;

type Parsed<S extends ParamSchema> = {
	[K in keyof S]: S[K] extends ParamCodec<infer T> ? T : never;
};

/** A nested object parsed against its own sub-schema. */
export function objectOf<S extends ParamSchema>(
	schema: S,
): ParamCodec<Parsed<S>> {
	const expected = "an object";
	return {
		expected,
		parse(raw) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				return fail(expected, raw);
			}
			const source = raw as Record<string, unknown>;
			const value: Record<string, unknown> = {};
			const errors: string[] = [];
			for (const key of Object.keys(schema)) {
				const result = schema[key].parse(source[key]);
				if (result.ok) {
					value[key] = result.value;
				} else {
					errors.push(`\`${key}\` ${result.error}`);
				}
			}
			if (errors.length > 0) {
				return { ok: false, error: `an object whose ${errors.join("; ")}` };
			}
			return ok(value as Parsed<S>);
		},
	};
}

/**
 * Parse a whole tool params object against a schema. Aggregates every field
 * error into one agent-actionable message; on success returns a typed record.
 */
export function parseParams<S extends ParamSchema>(
	toolName: string,
	schema: S,
	raw: unknown,
): { ok: true; value: Parsed<S> } | { ok: false; error: string } {
	const params = asObject(raw);
	const value: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const key of Object.keys(schema)) {
		const result = schema[key].parse(params[key]);
		if (result.ok) {
			value[key] = result.value;
		} else {
			errors.push(`  \`${key}\`: ${result.error}`);
		}
	}
	if (errors.length > 0) {
		return {
			ok: false,
			error: `${toolName}: invalid arguments.\n${errors.join("\n")}`,
		};
	}
	return { ok: true, value: value as Parsed<S> };
}
