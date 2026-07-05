import { SCHEMA_VERSION } from "../constants";
import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { PlanStoragePaths } from "./paths";

/**
 * SDD spec artifact (docs/sdd/SPEC.md §5.1) — the machine half (`spec.json`)
 * plus the generated human half (`spec.md`). The record is the single source
 * of truth: `spec.md` is always rendered from it, never authored separately.
 *
 * Validation here is the local-model hardening line (REQ-12/13/14): the model
 * authors this structured record and a deterministic compiler emits the gate
 * VRF from it — the model never hand-writes gate VRF, so every sharp edge of
 * the DSL (identifier rules, invented syntax) is enforced at submit time with
 * self-contained error messages instead of surfacing as engine parse errors.
 */

export type SpecPriority = "must" | "should" | "could";

export interface SpecRequirement {
	/** Stable human-visible id, strictly `REQ-<n>` (REQ-2). */
	id: string;
	statement: string;
	/** Human acceptance criterion (always present, even when formalized). */
	acceptance: string;
	/**
	 * Optional VRF atom → a `PROVE` target emitted by the spec compiler.
	 * Present = the requirement is formalized; absent requires `deferral`
	 * (REQ-14 — the freedom valve is the only legitimate omission).
	 */
	acceptanceAtom?: string;
	priority: SpecPriority;
	inScope: boolean;
	/** Freedom-valve record (§2.2): why this requirement is not VRF-expressible. */
	deferral?: { rationale: string };
}

/**
 * Machine half of a constraint (§2.1 structural/relational data): a logical
 * relation over boolean-leaf atoms. This is what makes the spec-consistency
 * gate non-vacuous — the engine can only find contradictions and gaps in
 * relations it can see. An atom referenced here that no assumption or
 * acceptance establishes surfaces as a WARNING naming it: a concrete gap to
 * elicit. In `implies.when`, a `!` prefix negates the atom.
 */
export type SpecConstraintRelation =
	| { type: "implies"; when: string[]; then: string }
	| { type: "exclusive" | "oneof" | "atleast"; atoms: string[] };

export interface SpecConstraint {
	/** Stable id, strictly `CON-<n>`. */
	id: string;
	statement: string;
	kind: "invariant";
	/** Optional logical form; prose-only constraints stay human-checked. */
	relation?: SpecConstraintRelation;
}

export interface SpecAssumption {
	/** Stable id, strictly `ASM-<n>`. */
	id: string;
	/** Boolean leaf (§2.1): the VRF atom the LLM computed outside the fence. */
	atom: string;
	negated: boolean;
	/** Evidence (REQ-13): must cite the source/command that established it. */
	statement: string;
}

export interface SpecRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	requirements: SpecRequirement[];
	nonGoals: string[];
	constraints: SpecConstraint[];
	assumptions: SpecAssumption[];
}

export interface SpecRecordInput {
	requirements: SpecRequirement[];
	nonGoals?: string[];
	constraints?: SpecConstraint[];
	assumptions?: SpecAssumption[];
}

// Mirrors elenchus-parser identifier rules (grammar.rs) narrowed to ASCII
// lowercase: keywords are ALWAYS CAPS, so a lowercase-first identifier can
// never collide with one, and `.`/space are structurally excluded.
const VRF_ATOM_PATTERN = /^[a-z][a-z0-9_]*$/;

const SPEC_PRIORITIES: readonly SpecPriority[] = ["must", "should", "could"];

export function validateSpecRecord(input: SpecRecordInput): SpecRecord {
	const requirements = requireArray(input.requirements, "requirements");
	if (requirements.length === 0) {
		throw new TypeError(
			"requirements must contain at least one requirement (an empty spec cannot gate anything).",
		);
	}
	const nonGoals = trimmedStrings(input.nonGoals ?? [], "nonGoals");
	const constraints = requireArray(input.constraints ?? [], "constraints");
	const assumptions = requireArray(input.assumptions ?? [], "assumptions");

	const seenIds = new Set<string>();
	const seenAtoms = new Set<string>();
	const claimAtom = (atom: string, where: string) => {
		if (seenAtoms.has(atom)) {
			throw new TypeError(
				`${where}: atom "${atom}" is already used elsewhere in the spec; every acceptanceAtom/assumption atom must be unique or the VRF facts would silently merge.`,
			);
		}
		seenAtoms.add(atom);
	};

	const normalizedRequirements = requirements.map((req, index) => {
		const where = `requirements[${index}]`;
		const id = requiredId(req.id, /^REQ-\d+$/, "REQ-<n>", where);
		if (seenIds.has(id)) throw duplicateId(id, where);
		seenIds.add(id);
		const statement = requiredText(req.statement, `${where}.statement`);
		const acceptance = requiredText(req.acceptance, `${where}.acceptance`);
		if (!SPEC_PRIORITIES.includes(req.priority)) {
			throw new TypeError(
				`${where}.priority must be one of ${SPEC_PRIORITIES.join(" | ")}.`,
			);
		}
		if (typeof req.inScope !== "boolean") {
			throw new TypeError(`${where}.inScope must be a boolean.`);
		}
		const acceptanceAtom =
			req.acceptanceAtom === undefined
				? undefined
				: requiredAtom(req.acceptanceAtom, `${where}.acceptanceAtom`);
		const rationale = req.deferral?.rationale?.trim() ?? "";
		if (acceptanceAtom !== undefined && req.deferral !== undefined) {
			throw new TypeError(
				`${where}: acceptanceAtom and deferral are mutually exclusive — a requirement is either formalized (acceptanceAtom) or deferred to human judgment (deferral.rationale), never both.`,
			);
		}
		// REQ-14: an omitted acceptanceAtom is only legitimate as a recorded
		// freedom-valve deferral. An unexplained omission is rejected here.
		if (acceptanceAtom === undefined && rationale === "") {
			throw new TypeError(
				`${where}: acceptanceAtom is missing and deferral.rationale is empty. Either formalize the requirement (set acceptanceAtom, lowercase snake_case) or defer it explicitly with a non-empty deferral.rationale explaining why it is not VRF-expressible.`,
			);
		}
		if (acceptanceAtom !== undefined) {
			claimAtom(acceptanceAtom, `${where}.acceptanceAtom`);
		}
		return {
			id,
			statement,
			acceptance,
			...(acceptanceAtom !== undefined ? { acceptanceAtom } : {}),
			priority: req.priority,
			inScope: req.inScope,
			...(rationale !== "" ? { deferral: { rationale } } : {}),
		} satisfies SpecRequirement;
	});

	const normalizedConstraints = constraints.map((con, index) => {
		const where = `constraints[${index}]`;
		const id = requiredId(con.id, /^CON-\d+$/, "CON-<n>", where);
		if (seenIds.has(id)) throw duplicateId(id, where);
		seenIds.add(id);
		if (con.kind !== "invariant") {
			throw new TypeError(`${where}.kind must be "invariant".`);
		}
		const relation =
			con.relation === undefined
				? undefined
				: validateConstraintRelation(con.relation, `${where}.relation`);
		return {
			id,
			statement: requiredText(con.statement, `${where}.statement`),
			kind: con.kind,
			...(relation !== undefined ? { relation } : {}),
		} satisfies SpecConstraint;
	});

	const normalizedAssumptions = assumptions.map((asm, index) => {
		const where = `assumptions[${index}]`;
		const id = requiredId(asm.id, /^ASM-\d+$/, "ASM-<n>", where);
		if (seenIds.has(id)) throw duplicateId(id, where);
		seenIds.add(id);
		const atom = requiredAtom(asm.atom, `${where}.atom`);
		claimAtom(atom, `${where}.atom`);
		if (typeof asm.negated !== "boolean") {
			throw new TypeError(`${where}.negated must be a boolean.`);
		}
		// REQ-13: an assumption is a boolean leaf elenchus must trust, so the
		// statement has to carry the evidence that established the predicate.
		return {
			id,
			atom,
			negated: asm.negated,
			statement: requiredText(asm.statement, `${where}.statement`),
		} satisfies SpecAssumption;
	});

	return {
		schemaVersion: SCHEMA_VERSION,
		requirements: normalizedRequirements,
		nonGoals,
		constraints: normalizedConstraints,
		assumptions: normalizedAssumptions,
	};
}

export async function writeSpecArtifacts(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	record: SpecRecord,
): Promise<void> {
	await writeJson(fs, planPaths.specJson, record);
	await fs.writeTextAtomic(planPaths.specMd, formatSpecMarkdown(record));
}

export async function readSpecRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<SpecRecord> {
	return await readJson<SpecRecord>(fs, planPaths.specJson);
}

/** Legacy plans predate the SDD layer; absence is a supported state (REQ-11). */
export async function readSpecRecordIfExists(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<SpecRecord | null> {
	return await readJsonIfExists<SpecRecord>(fs, planPaths.specJson);
}

export function formatSpecMarkdown(record: SpecRecord): string {
	const lines: string[] = ["# Specification", ""];
	lines.push("## Requirements", "");
	for (const req of record.requirements) {
		const scope = req.inScope ? "in scope" : "out of scope";
		lines.push(`### ${req.id} — ${req.statement}`, "");
		lines.push(`- Priority: ${req.priority} (${scope})`);
		lines.push(`- Acceptance: ${req.acceptance}`);
		if (req.acceptanceAtom) {
			lines.push(`- Acceptance atom: \`${req.acceptanceAtom}\``);
		}
		if (req.deferral) {
			lines.push(
				`- Deferred to human judgment (freedom valve): ${req.deferral.rationale}`,
			);
		}
		lines.push("");
	}
	lines.push("## Non-Goals", "");
	lines.push(...bulletList(record.nonGoals, "(none recorded)"), "");
	lines.push("## Constraints", "");
	lines.push(
		...bulletList(
			record.constraints.map(
				(con) =>
					`${con.id} — ${con.statement}${formatRelationSuffix(con.relation)}`,
			),
			"(none recorded)",
		),
		"",
	);
	lines.push("## Assumptions (boolean leaves)", "");
	lines.push(
		...bulletList(
			record.assumptions.map(
				(asm) =>
					`${asm.id} — \`${asm.negated ? "NOT " : ""}${asm.atom}\` — ${asm.statement}`,
			),
			"(none recorded)",
		),
		"",
	);
	return lines.join("\n");
}

function formatRelationSuffix(
	relation: SpecConstraintRelation | undefined,
): string {
	if (!relation) return "";
	if (relation.type === "implies") {
		return ` — \`${relation.when.join(" ∧ ")} → ${relation.then}\``;
	}
	const label =
		relation.type === "exclusive"
			? "at most one of"
			: relation.type === "oneof"
				? "exactly one of"
				: "at least one of";
	return ` — ${label}: \`${relation.atoms.join("`, `")}\``;
}

function bulletList(values: readonly string[], empty: string): string[] {
	return values.length > 0
		? values.map((value) => `- ${value}`)
		: [`- ${empty}`];
}

function requireArray<T>(value: readonly T[], key: string): readonly T[] {
	if (!Array.isArray(value)) throw new TypeError(`${key} must be an array.`);
	return value;
}

function trimmedStrings(values: readonly string[], key: string): string[] {
	if (
		!Array.isArray(values) ||
		!values.every((value) => typeof value === "string")
	) {
		throw new TypeError(`${key} must be a string array.`);
	}
	return values.map((value) => value.trim()).filter(Boolean);
}

function requiredText(value: string, key: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized) throw new TypeError(`${key} must be a non-empty string.`);
	return normalized;
}

function requiredId(
	value: string,
	pattern: RegExp,
	shape: string,
	where: string,
): string {
	const normalized = requiredText(value, `${where}.id`);
	if (!pattern.test(normalized)) {
		throw new TypeError(
			`${where}.id must match ${shape} (got "${normalized}").`,
		);
	}
	return normalized;
}

function requiredAtom(value: string, key: string): string {
	const normalized = requiredText(value, key);
	if (!VRF_ATOM_PATTERN.test(normalized)) {
		throw new TypeError(
			`${key} must be a valid VRF atom: lowercase snake_case starting with a letter (e.g. "latency_within_budget"); got "${normalized}".`,
		);
	}
	return normalized;
}

function duplicateId(id: string, where: string): TypeError {
	return new TypeError(`${where}.id "${id}" is declared more than once.`);
}

/** An atom reference in a relation; `!atom` negates it (implies only). */
function requiredAtomRef(
	value: string,
	key: string,
	allowNegation: boolean,
): string {
	const normalized = requiredText(value, key);
	const negated = normalized.startsWith("!");
	if (negated && !allowNegation) {
		throw new TypeError(
			`${key}: negation ("!") is only allowed inside an "implies" relation; got "${normalized}".`,
		);
	}
	const bare = negated ? normalized.slice(1) : normalized;
	if (!VRF_ATOM_PATTERN.test(bare)) {
		throw new TypeError(
			`${key} must be a valid VRF atom (lowercase snake_case, optional leading "!"); got "${normalized}".`,
		);
	}
	return normalized;
}

function validateConstraintRelation(
	relation: SpecConstraintRelation,
	where: string,
): SpecConstraintRelation {
	if (!relation || typeof relation !== "object") {
		throw new TypeError(`${where} must be an object.`);
	}
	if (relation.type === "implies") {
		const when = requireArray(relation.when, `${where}.when`).map(
			(atom, index) => requiredAtomRef(atom, `${where}.when[${index}]`, true),
		);
		if (when.length === 0) {
			throw new TypeError(`${where}.when must contain at least one atom.`);
		}
		return {
			type: "implies",
			when,
			then: requiredAtomRef(relation.then, `${where}.then`, true),
		};
	}
	if (
		relation.type === "exclusive" ||
		relation.type === "oneof" ||
		relation.type === "atleast"
	) {
		const atoms = requireArray(relation.atoms, `${where}.atoms`).map(
			(atom, index) => requiredAtomRef(atom, `${where}.atoms[${index}]`, false),
		);
		if (atoms.length < 2) {
			throw new TypeError(
				`${where}.atoms must contain at least two atoms for "${relation.type}".`,
			);
		}
		if (new Set(atoms).size !== atoms.length) {
			throw new TypeError(`${where}.atoms must not repeat an atom.`);
		}
		return { type: relation.type, atoms };
	}
	throw new TypeError(
		`${where}.type must be "implies", "exclusive", "oneof", or "atleast".`,
	);
}
