import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sha256 } from "../hash";
import { isPathInsideOrEqual } from "../path-utils";
import { runElenchusCheck } from "../runtime/elenchus-engine";
import { withFileWriteLock } from "../storage/file-lock";
import type { PlannerFs } from "../storage/fs";
import { safeReaddir } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";
import type { PlanStoragePaths } from "../storage/paths";
import type { SpecRecord } from "../storage/spec-store";
import { compileSpecConsistency } from "./spec-compiler";

/**
 * The plan's living logical world: a persistent registry of model-asserted
 * VRF statements (`<planDir>/elenchus/world/world.json`) compiled into a
 * multi-domain program the engine re-checks as a whole. Unlike the one-shot
 * programs of `planner_elenchus_check`, statements accumulate across stages,
 * so every new assertion is tested against everything asserted before.
 *
 * The store treats the engine exactly as `planner_elenchus_check` does: it runs
 * a program, scans the output for one of four verdict codes, and hands the raw
 * output to callers verbatim. It never parses the report body — no orphans, no
 * beliefs, no derivations — so it stays decoupled from the engine's private
 * JSON shape. Everything a fuel/directive layer needs beyond the verdict comes
 * from the planner's own artifacts, never from the engine's output.
 *
 * Statements about project files carry an anchor (path + content hash taken
 * at assert time). When the file changes, the compiler demotes the statement
 * from knowledge to belief (`FACT …` → `BELIEVES planner …`): stale knowledge
 * can no longer raise a false CONFLICT, and the demoted line reaches the model
 * directly in the raw output (a rule deriving its negation surfaces it there as
 * a named false belief). The staleness the planner acts on comes from its own
 * hash sweep ({@link sweepWorldAnchors}), not from reading the report.
 *
 * Domains form a fixed acyclic layer order (spec → discovery → plan →
 * task_<id> → scratch; task domains alphabetical among themselves). Each
 * compiled file imports every earlier domain in that total order, because the
 * engine resolves qualified cross-domain references only through the
 * referencing file's own imports and rejects import cycles (probed). The
 * consequences: statements may reference earlier layers (`discovery.cache
 * is_lru` from `plan`), never later ones — a link pointing "forward" belongs
 * in the later domain; and since elenchus SETs do not cross files, a SET and
 * its FOR EACH consumers must live in the same domain.
 *
 * The world holds only establishing/constraining statements (facts, premises,
 * rules, beliefs, sets, closures, vars). Instruments (PROVE/HENCE/TRY) are
 * run-scoped questions, not territory — they are posed per run by the reason
 * tool, and CHECK/IMPORT/DOMAIN lines are compiler-owned.
 */

/**
 * The engine's terminal verdict, scanned from its output as one of four codes
 * (or "unknown"). This scan is the whole of the store's coupling to the
 * engine: the report body is never parsed.
 */
export type WorldVerdict =
	| "CONSISTENT"
	| "WARNING"
	| "UNDERDETERMINED"
	| "CONFLICT"
	| "unknown";

const WORLD_VERDICTS: readonly WorldVerdict[] = [
	"CONSISTENT",
	"WARNING",
	"UNDERDETERMINED",
	"CONFLICT",
];

/** First verdict code present in the engine output, or "unknown". */
export function detectWorldVerdict(output: string): WorldVerdict {
	for (const verdict of WORLD_VERDICTS) {
		if (output.includes(verdict)) return verdict;
	}
	return "unknown";
}

/**
 * Whether the engine output is a JSON object (a real verdict) rather than a
 * plain-text diagnostic (syntax/citation/resolver error). Used only to route a
 * diagnostic to a failure — no field of the parsed object is ever read.
 */
function isJsonVerdictBody(output: string): boolean {
	try {
		const parsed: unknown = JSON.parse(output);
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

export type WorldStatementKind =
	| "fact"
	| "not"
	| "assume"
	| "premise"
	| "rule"
	| "believes"
	| "set"
	| "close"
	| "var";

export interface WorldAnchor {
	/** Project-root-relative file the statement observes. */
	path: string;
	/** sha256 of that file's content when the statement was asserted. */
	hash: string;
}

export interface WorldOrigin {
	stage: string;
	step: string;
}

export interface WorldStatement {
	/** Store-assigned id, `w<n>` — the handle retract/repair texts use. */
	id: string;
	kind: WorldStatementKind;
	/** Verbatim .vrf lines (one statement, possibly a multi-line block). */
	lines: string[];
	domain: string;
	anchor?: WorldAnchor;
	origin: WorldOrigin;
	assertedAt: string;
}

export interface WorldRecord {
	version: 1;
	nextId: number;
	statements: WorldStatement[];
}

export interface WorldStatementInput {
	lines: string[];
	domain: string;
	anchor?: WorldAnchor;
	origin: WorldOrigin;
}

export interface WorldStaleAnchor {
	statementId: string;
	path: string;
}

export interface WorldSourceMapEntry {
	/** Compiled file, relative to the plan's elenchus dir. */
	file: string;
	/** 1-based line within that file. */
	line: number;
	statementId: string;
}

export interface CompiledWorld {
	/** File name (relative to the elenchus dir) → content. */
	files: Map<string, string>;
	/** VAR port values the run must pass (the spec claim port when included). */
	values: Record<string, boolean>;
	/** Maps every emitted statement line back to its statement id. */
	sourceMap: WorldSourceMapEntry[];
	/** Model domains in compile (layer) order; excludes the spec domain. */
	domains: string[];
	/** Statements demoted to beliefs because their anchor went stale. */
	demoted: WorldStaleAnchor[];
	/** sha256 over all compiled files — the world's content fingerprint. */
	worldHash: string;
}

/**
 * The last persisted world run. Holds only the verdict code and provenance —
 * never the report body — so nothing downstream can grow a dependency on the
 * engine's private JSON shape. Callers that need the run's detail read the raw
 * output the run returned, not this record.
 */
export interface WorldRunRecord {
	recordedAt: string;
	verdict: WorldVerdict;
	engineVersion: string;
	worldHash: string;
	demoted: WorldStaleAnchor[];
}

export type WorldRunResult =
	| {
			ok: true;
			verdict: WorldVerdict;
			/** The engine's raw output, handed to the model verbatim. */
			output: string;
			compiled: CompiledWorld;
			engineVersion: string;
	  }
	| { ok: false; reason: string };

const WORLD_DIR = "world";
const WORLD_JSON_FILE = "world.json";
const WORLD_RESULT_FILE = "last-run.json";
const WORLD_ENTRY_FILE = "main.vrf";
const SPEC_DOMAIN_FILE = "spec.vrf";

/** Engine entry path, relative to the elenchus dir (the resolver root). */
export const WORLD_ENTRY_NAME = `${WORLD_DIR}/${WORLD_ENTRY_FILE}`;

// Closed domain shape: discovery | plan | task_<slug> | scratch. "main" and
// "spec" can never collide because neither matches the pattern.
const WORLD_DOMAIN_PATTERN = /^(discovery|plan|scratch|task_[a-z0-9_]{1,48})$/;

// First keyword of a statement → its kind. KNOWS is epistemic like BELIEVES;
// quantifiers/coverage/preference forms check rather than establish, so they
// count as premises for the structural signals.
const KEYWORD_KINDS: Readonly<Record<string, WorldStatementKind>> = {
	FACT: "fact",
	NOT: "not",
	ASSUME: "assume",
	PREMISE: "premise",
	RULE: "rule",
	BELIEVES: "believes",
	KNOWS: "believes",
	SET: "set",
	CLOSE: "close",
	VAR: "var",
	DEFAULT: "var",
	TOTAL: "premise",
	EXISTS: "premise",
	FOR: "premise",
	PREFERS: "premise",
};

const INSTRUMENT_KEYWORDS = new Set(["PROVE", "HENCE", "TRY"]);
const COMPILER_KEYWORDS = new Set(["CHECK", "IMPORT", "DOMAIN", "PROVIDE"]);

export function worldDirPath(planPaths: PlanStoragePaths): string {
	return join(planPaths.elenchusDir, WORLD_DIR);
}

export function worldJsonPath(planPaths: PlanStoragePaths): string {
	return join(worldDirPath(planPaths), WORLD_JSON_FILE);
}

function worldResultPath(planPaths: PlanStoragePaths): string {
	return join(worldDirPath(planPaths), WORLD_RESULT_FILE);
}

function emptyWorldRecord(): WorldRecord {
	return { version: 1, nextId: 1, statements: [] };
}

export async function readWorldRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<WorldRecord> {
	return (
		(await readJsonIfExists<WorldRecord>(fs, worldJsonPath(planPaths))) ??
		emptyWorldRecord()
	);
}

/**
 * Serialized read-modify-write on world.json — same lost-update class as
 * plan.json: Pi runs same-message tool calls concurrently, so a batch of
 * asserts would otherwise clobber each other. See {@link withFileWriteLock}.
 */
export async function updateWorldRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	update: (record: WorldRecord) => WorldRecord,
): Promise<WorldRecord> {
	const path = worldJsonPath(planPaths);
	return await withFileWriteLock(path, async () => {
		const current =
			(await readJsonIfExists<WorldRecord>(fs, path)) ?? emptyWorldRecord();
		const next = update(current);
		await writeJson(fs, path, next);
		return next;
	});
}

function firstKeyword(line: string): string {
	return line.trim().split(/\s+/, 1)[0] ?? "";
}

function isStatementText(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 0 && !trimmed.startsWith("//");
}

/**
 * Validate one statement input and infer its kind from the first keyword.
 * Throws with a model-actionable message: what was rejected and which move
 * expresses that intent instead.
 */
export function validateWorldStatementInput(
	input: WorldStatementInput,
): Omit<WorldStatement, "id" | "assertedAt"> {
	const domain = input.domain.trim();
	if (!WORLD_DOMAIN_PATTERN.test(domain)) {
		throw new Error(
			`World domain "${domain}" is not valid. Use "discovery", "plan", "scratch", or "task_<slug>" (lowercase letters, digits, underscores).`,
		);
	}
	const lines = input.lines.map((line) => line.replace(/\s+$/, ""));
	const textLines = lines.filter(isStatementText);
	if (textLines.length === 0) {
		throw new Error(
			"A world statement needs at least one non-comment .vrf line.",
		);
	}
	for (const line of textLines) {
		const keyword = firstKeyword(line);
		if (INSTRUMENT_KEYWORDS.has(keyword)) {
			throw new Error(
				`${keyword} is an instrument, not territory: it is posed per run, never stored. Use the matching reason mode (prove/hence/abduct) instead of asserting it into the world.`,
			);
		}
		if (COMPILER_KEYWORDS.has(keyword)) {
			throw new Error(
				`${keyword} lines are owned by the world compiler and cannot be asserted. State only facts, premises, rules, beliefs, sets, closures, or vars.`,
			);
		}
	}
	const kind = KEYWORD_KINDS[firstKeyword(textLines[0] ?? "")];
	if (!kind) {
		throw new Error(
			`Statement must start with one of: ${Object.keys(KEYWORD_KINDS).join(", ")}. Got "${firstKeyword(textLines[0] ?? "")}".`,
		);
	}
	const origin = {
		stage: input.origin.stage.trim(),
		step: input.origin.step.trim(),
	};
	if (!origin.stage || !origin.step) {
		throw new Error("Statement origin needs a non-empty stage and step.");
	}
	const anchor = validateAnchor(input.anchor, kind);
	return anchor
		? { kind, lines, domain, anchor, origin }
		: { kind, lines, domain, origin };
}

function validateAnchor(
	anchor: WorldAnchor | undefined,
	kind: WorldStatementKind,
): WorldAnchor | undefined {
	if (!anchor) return undefined;
	if (kind !== "fact" && kind !== "not") {
		throw new Error(
			`Anchors mark observations of files, so only FACT/NOT statements may carry one (got a ${kind}). State the observation as a FACT and put the law over it in a separate premise or rule.`,
		);
	}
	const path = anchor.path.trim().replace(/\\/g, "/");
	const hash = anchor.hash.trim();
	if (!path || !hash) {
		throw new Error("An anchor needs both a file path and a content hash.");
	}
	if (
		path.startsWith("/") ||
		/^[a-zA-Z]:/.test(path) ||
		path.split("/").includes("..")
	) {
		throw new Error(
			`Anchor path must be project-root-relative without ".." segments: "${anchor.path}".`,
		);
	}
	return { path, hash };
}

/**
 * Append validated statements atomically, assigning `w<n>` ids. All inputs
 * are validated before anything is written, so a batch is all-or-nothing.
 */
export async function assertWorldStatements(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	inputs: readonly WorldStatementInput[],
	now: () => string = () => new Date().toISOString(),
): Promise<WorldStatement[]> {
	const prepared = inputs.map(validateWorldStatementInput);
	let added: WorldStatement[] = [];
	await updateWorldRecord(fs, planPaths, (record) => {
		let nextId = record.nextId;
		added = prepared.map((statement) => ({
			id: `w${nextId++}`,
			assertedAt: now(),
			...statement,
		}));
		return {
			...record,
			nextId,
			statements: [...record.statements, ...added],
		};
	});
	return added;
}

/**
 * Remove statements by id. Never throws on unknown ids — retraction is the
 * anti-deadlock escape and must always succeed; unknown ids are reported so
 * the caller can name them.
 */
export async function retractWorldStatements(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	ids: readonly string[],
): Promise<{ removed: string[]; missing: string[] }> {
	const wanted = new Set(ids.map((id) => id.trim()).filter(Boolean));
	let removed: string[] = [];
	await updateWorldRecord(fs, planPaths, (record) => {
		removed = record.statements
			.filter((statement) => wanted.has(statement.id))
			.map((statement) => statement.id);
		return {
			...record,
			statements: record.statements.filter(
				(statement) => !wanted.has(statement.id),
			),
		};
	});
	const removedSet = new Set(removed);
	return {
		removed,
		missing: [...wanted].filter((id) => !removedSet.has(id)),
	};
}

/** Sorted unique anchor paths — what a sweep must hash. */
export function collectAnchorPaths(record: WorldRecord): string[] {
	const paths = new Set<string>();
	for (const statement of record.statements) {
		if (statement.anchor) paths.add(statement.anchor.path);
	}
	return [...paths].sort();
}

/**
 * Compare stored anchor hashes against current file hashes. `null` means the
 * file is gone (stale); a path missing from the map was not sampled and is
 * treated as fresh — pass every {@link collectAnchorPaths} entry for a full
 * sweep.
 */
export function sweepWorldAnchors(
	record: WorldRecord,
	currentHashes: ReadonlyMap<string, string | null>,
): WorldStaleAnchor[] {
	const stale: WorldStaleAnchor[] = [];
	for (const statement of record.statements) {
		const anchor = statement.anchor;
		if (!anchor) continue;
		const current = currentHashes.get(anchor.path);
		if (current === undefined) continue;
		if (current === null || current !== anchor.hash) {
			stale.push({ statementId: statement.id, path: anchor.path });
		}
	}
	return stale;
}

function statementIdNumber(id: string): number {
	const match = /^w(\d+)$/.exec(id);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// Layer order for the acyclic import chain; ties break alphabetically.
function domainLayer(domain: string): number {
	if (domain === "discovery") return 0;
	if (domain === "plan") return 1;
	if (domain.startsWith("task_")) return 2;
	return 3; // scratch
}

function compareDomains(a: string, b: string): number {
	return domainLayer(a) - domainLayer(b) || a.localeCompare(b, "en");
}

/**
 * Demote a stale observation line from knowledge to belief. Only FACT/NOT
 * lines change; the engine's BELIEVES form takes no BECAUSE clause, so an
 * evidence clause moves into the trailing comment.
 */
function demoteLine(line: string, path: string): string {
	const because = /\s+BECAUSE\s+"[^"]*"\s*$/.exec(line);
	const bare = because ? line.slice(0, because.index) : line;
	const demoted = bare
		.replace(/^(\s*)FACT\s+/, "$1BELIEVES planner ")
		.replace(/^(\s*)NOT\s+/, "$1BELIEVES planner NOT ");
	return `${demoted} // stale anchor: ${path} changed since asserted`;
}

/**
 * Deterministically compile the registry into per-domain files plus the
 * `main.vrf` entry (`CHECK BIDIRECTIONAL`). Statements sort by id within a
 * domain and domains by layer, so byte-identical output never depends on
 * registry order. When `spec` is given, the spec-consistency program joins
 * the world as its ground layer under `spec.vrf` (every domain imports it).
 */
export function compileWorld(
	record: WorldRecord,
	options: {
		stale?: readonly WorldStaleAnchor[];
		spec?: SpecRecord | null;
	} = {},
): CompiledWorld {
	const staleById = new Map(
		(options.stale ?? []).map((entry) => [entry.statementId, entry]),
	);
	const byDomain = new Map<string, WorldStatement[]>();
	for (const statement of record.statements) {
		if (!WORLD_DOMAIN_PATTERN.test(statement.domain)) {
			throw new Error(
				`world.json contains an invalid domain "${statement.domain}" (statement ${statement.id}) — the registry was edited outside the reason tool.`,
			);
		}
		const group = byDomain.get(statement.domain) ?? [];
		group.push(statement);
		byDomain.set(statement.domain, group);
	}
	const domains = [...byDomain.keys()].sort(compareDomains);

	const files = new Map<string, string>();
	const sourceMap: WorldSourceMapEntry[] = [];
	const demoted: WorldStaleAnchor[] = [];
	let values: Record<string, boolean> = {};

	let hasSpec = false;
	if (options.spec) {
		const compiledSpec = compileSpecConsistency(options.spec);
		// The spec program imports its template relative to the elenchus dir;
		// from inside world/ that is one level up.
		files.set(
			`${WORLD_DIR}/${SPEC_DOMAIN_FILE}`,
			compiledSpec.program.replace(
				'IMPORT "templates/spec-consistency.vrf"',
				'IMPORT "../templates/spec-consistency.vrf"',
			),
		);
		values = { ...compiledSpec.values };
		hasSpec = true;
	}

	const importsFor = (index: number): string[] => {
		const imports: string[] = [];
		if (hasSpec) imports.push(`IMPORT "${SPEC_DOMAIN_FILE}"`);
		for (const earlier of domains.slice(0, index)) {
			imports.push(`IMPORT "${earlier}.vrf"`);
		}
		return imports;
	};

	domains.forEach((domain, index) => {
		const file = `${WORLD_DIR}/${domain}.vrf`;
		const lines: string[] = [
			"// Generated by pi-code-planner's world compiler from world.json —",
			"// do not edit by hand; grow the world through the reason tool.",
			`DOMAIN ${domain}`,
			...importsFor(index),
		];
		const statements = [...(byDomain.get(domain) ?? [])].sort(
			(a, b) => statementIdNumber(a.id) - statementIdNumber(b.id),
		);
		for (const statement of statements) {
			lines.push("");
			const anchorNote = statement.anchor
				? ` [anchor ${statement.anchor.path}]`
				: "";
			lines.push(
				`// ${statement.id} (${statement.origin.stage}/${statement.origin.step})${anchorNote}`,
			);
			const staleEntry = staleById.get(statement.id);
			if (staleEntry) demoted.push(staleEntry);
			for (const line of statement.lines) {
				lines.push(
					staleEntry && isStatementText(line)
						? demoteLine(line, staleEntry.path)
						: line,
				);
				sourceMap.push({
					file,
					line: lines.length,
					statementId: statement.id,
				});
			}
		}
		files.set(file, `${lines.join("\n")}\n`);
	});

	const entryLines: string[] = [
		"// Generated by pi-code-planner's world compiler — the entry that checks",
		"// the whole living world in one run.",
		"DOMAIN world",
		...importsFor(domains.length),
		"",
		"CHECK BIDIRECTIONAL",
	];
	files.set(WORLD_ENTRY_NAME, `${entryLines.join("\n")}\n`);

	const worldHash = sha256(
		[...files.keys()]
			.sort()
			.map((name) => `${name}\n${files.get(name) ?? ""}`)
			.join("\n---\n"),
	);
	return { files, values, sourceMap, domains, demoted, worldHash };
}

/**
 * Materialize compiled files under `world/` and prune compiled `.vrf` files
 * whose domain no longer exists, so the directory always mirrors the registry.
 */
export async function writeCompiledWorld(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	compiled: CompiledWorld,
): Promise<void> {
	const dir = worldDirPath(planPaths);
	await fs.mkdirp(dir);
	for (const [name, content] of compiled.files) {
		await fs.writeTextAtomic(join(planPaths.elenchusDir, name), content);
	}
	const keep = new Set(
		[...compiled.files.keys()].map((name) => basename(name)),
	);
	for (const entry of await safeReaddir(fs, dir)) {
		if (entry.endsWith(".vrf") && !keep.has(entry)) {
			await fs.removeFile(join(dir, entry));
		}
	}
}

/**
 * Compile the current registry (sweeping anchors when a hasher is provided),
 * write it, and run the engine over the whole world. A plain-text engine
 * diagnostic (bad premise body, etc.) comes back as `ok: false` with the text
 * verbatim. On success the verdict persists to `world/last-run.json` and the
 * raw output is returned for the caller to hand to the model.
 */
export async function runWorldCheck(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	input: {
		spec?: SpecRecord | null;
		/** Hash a project-root-relative file; null when it does not exist. */
		hashProjectFile?: (path: string) => Promise<string | null>;
		values?: Record<string, boolean>;
		now?: () => string;
	} = {},
): Promise<WorldRunResult> {
	const record = await readWorldRecord(fs, planPaths);
	let stale: WorldStaleAnchor[] = [];
	if (input.hashProjectFile) {
		const hashes = new Map<string, string | null>();
		for (const path of collectAnchorPaths(record)) {
			hashes.set(path, await input.hashProjectFile(path));
		}
		stale = sweepWorldAnchors(record, hashes);
	}
	const compiled = compileWorld(record, { stale, spec: input.spec ?? null });
	await writeCompiledWorld(fs, planPaths, compiled);

	const elenchusDir = planPaths.elenchusDir;
	const read = (path: string): string => {
		const target = resolve(elenchusDir, path);
		if (!isPathInsideOrEqual(target, elenchusDir)) {
			throw new Error(`elenchus import escapes the plan dir: ${path}`);
		}
		return readFileSync(target, "utf8");
	};
	const run = await runElenchusCheck({
		root: WORLD_ENTRY_NAME,
		read,
		format: "json",
		// Compiled values win so a caller cannot unset the spec claim port.
		values: { ...input.values, ...compiled.values },
	});
	if (!run.ok) return { ok: false, reason: run.reason };
	// A plain-text diagnostic (bad premise body, citation, resolver failure) is
	// not a verdict — surface it verbatim as a failure, like runCheck does.
	if (!isJsonVerdictBody(run.output)) {
		return { ok: false, reason: run.output.trim() };
	}
	const verdict = detectWorldVerdict(run.output);
	const runRecord: WorldRunRecord = {
		recordedAt: (input.now ?? (() => new Date().toISOString()))(),
		verdict,
		engineVersion: run.engineVersion,
		worldHash: compiled.worldHash,
		demoted: compiled.demoted,
	};
	await writeJson(fs, worldResultPath(planPaths), runRecord);
	return {
		ok: true,
		verdict,
		output: run.output.trim(),
		compiled,
		engineVersion: run.engineVersion,
	};
}

/** The last persisted world run, or null before the first check. */
export async function readWorldRunRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<WorldRunRecord | null> {
	return await readJsonIfExists<WorldRunRecord>(fs, worldResultPath(planPaths));
}
