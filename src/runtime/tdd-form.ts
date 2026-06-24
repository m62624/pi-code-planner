import {
	isTddPlaceholder,
	MERGE_SCOPE_AUDIT_FIELDS,
	MERGE_SCOPE_AUDIT_SECTION,
	POST_IMPLEMENTATION_FIELDS,
	POST_IMPLEMENTATION_SECTION,
	PRE_IMPLEMENTATION_FIELDS,
	PRE_IMPLEMENTATION_SECTION,
} from "./tdd-evidence";

export type TddSectionKey =
	| "preImplementation"
	| "postImplementation"
	| "mergeScopeAudit";

interface TddSectionDef {
	key: TddSectionKey;
	title: string;
	fields: readonly string[];
}

// Canonical order matches the lifecycle: proof contract first, counterexample
// review after implementation, merge audit before the task lands.
export const TDD_SECTIONS: readonly TddSectionDef[] = [
	{
		key: "preImplementation",
		title: PRE_IMPLEMENTATION_SECTION,
		fields: PRE_IMPLEMENTATION_FIELDS,
	},
	{
		key: "postImplementation",
		title: POST_IMPLEMENTATION_SECTION,
		fields: POST_IMPLEMENTATION_FIELDS,
	},
	{
		key: "mergeScopeAudit",
		title: MERGE_SCOPE_AUDIT_SECTION,
		fields: MERGE_SCOPE_AUDIT_FIELDS,
	},
];

export type TddSectionValues = Record<string, string>;

/**
 * Validate and render one tdd.md section from structured field values. Throws
 * TypeError with an actionable message when a required field is missing or a
 * placeholder, so the model gets immediate feedback at submit time.
 */
export function renderTddSection(
	def: TddSectionDef,
	values: TddSectionValues,
): string {
	const lines = [`## ${def.title}`];
	for (const field of def.fields) {
		const raw = values[field];
		if (typeof raw !== "string" || raw.trim().length === 0) {
			throw new TypeError(
				`${def.title}: field "${field}" must be a non-empty string. Required fields: ${def.fields.join(", ")}.`,
			);
		}
		const value = raw.trim();
		if (isTddPlaceholder(value)) {
			throw new TypeError(
				`${def.title}: field "${field}" must contain concrete evidence, not a placeholder ("${value}").`,
			);
		}
		lines.push(`- ${field}: ${value}`);
	}
	return lines.join("\n");
}

/**
 * Merge the provided sections into existing tdd.md content, preserving any
 * sections not being updated. Known sections are emitted in canonical order;
 * unknown sections (e.g. from an external edit) are kept after them.
 */
export function mergeTddMarkdown(
	existing: string,
	updates: Partial<Record<TddSectionKey, string>>,
): string {
	const parsed = parseLevelTwoSections(existing);
	for (const def of TDD_SECTIONS) {
		const rendered = updates[def.key];
		if (rendered !== undefined) {
			parsed.set(def.title, rendered);
		}
	}

	const knownTitles = new Set(TDD_SECTIONS.map((def) => def.title));
	const blocks: string[] = [];
	for (const def of TDD_SECTIONS) {
		const block = parsed.get(def.title);
		if (block) {
			blocks.push(block.trimEnd());
		}
	}
	for (const [title, body] of parsed) {
		if (!knownTitles.has(title)) {
			blocks.push(`## ${title}\n${body}`.trimEnd());
		}
	}
	return `${blocks.join("\n\n")}\n`;
}

/**
 * Parse `## Heading` blocks, returning each section's full rendered text
 * (heading line included) keyed by heading. Mirrors the parser used by the
 * tdd-evidence validators so the round-trip stays consistent.
 */
function parseLevelTwoSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	let currentTitle: string | null = null;
	let buffer: string[] = [];

	const flush = () => {
		if (currentTitle !== null) {
			sections.set(currentTitle, [`## ${currentTitle}`, ...buffer].join("\n"));
		}
	};

	for (const line of text.split(/\r?\n/)) {
		const heading = /^##\s+(\S.*)$/.exec(line);
		if (heading) {
			flush();
			currentTitle = heading[1].trim();
			buffer = [];
			continue;
		}
		if (currentTitle !== null) {
			buffer.push(line);
		}
	}
	flush();
	return sections;
}
