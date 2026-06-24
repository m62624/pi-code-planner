// Thin loader around the `elenchus-wasm` npm package (the WebAssembly build of
// the elenchus logical-consistency engine). The engine, its JSON verdict format,
// and the companion skill all ship inside that single version-locked package, so
// nothing here reimplements engine logic — this only bridges it to the planner.
//
// The wasm is loaded lazily through a dynamic import and cached. A load failure
// (missing/broken wasm) never throws to callers: it degrades to a typed failure
// the tool turns into a blocked result, so the extension keeps working without
// elenchus.

export type ElenchusFormat = "json" | "human";

export type ElenchusRunResult =
	| { ok: true; output: string; engineVersion: string }
	| { ok: false; reason: string };

export type ElenchusSkill = { text: string; version: string };

// The curated Node surface of elenchus-wasm (see its index.d.ts). Imported as a
// type only so a load failure is handled at runtime, not at module evaluation.
type ElenchusModule = typeof import("elenchus-wasm");

let cached: ElenchusModule | null | undefined;

async function loadEngine(): Promise<ElenchusModule | null> {
	if (cached !== undefined) return cached;
	try {
		const mod = (await import("elenchus-wasm")) as unknown as ElenchusModule & {
			default?: ElenchusModule;
		};
		// elenchus-wasm is CommonJS (`module.exports = { check, ... }`); under
		// ESM interop the functions are available both as named exports and on
		// `default`. Prefer whichever actually carries `check`.
		cached = typeof mod.check === "function" ? mod : (mod.default ?? mod);
	} catch {
		cached = null;
	}
	return cached;
}

function unavailable(): ElenchusRunResult {
	return {
		ok: false,
		reason:
			"The elenchus engine (elenchus-wasm) could not be loaded. Reinstall the planner extension so its dependencies are present, then retry.",
	};
}

/**
 * Run a `.vrf` program through the engine, resolving every `IMPORT` through a
 * synchronous `read(path) => string` callback (throw to signal "not found").
 * `root` is the entry path handed to `read` first — so the entry source and its
 * imports are read uniformly from the caller's store.
 */
export async function runElenchusCheck(input: {
	root: string;
	read: (path: string) => string;
	format?: ElenchusFormat;
}): Promise<ElenchusRunResult> {
	const engine = await loadEngine();
	if (!engine) return unavailable();
	try {
		const output = engine.checkWithResolver(
			input.root,
			input.read,
			input.format ?? "json",
		);
		return { ok: true, output, engineVersion: engine.version() };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `elenchus run failed: ${detail}` };
	}
}

/** The running engine version, e.g. `"elenchus 0.9.2"`. Empty if unavailable. */
export async function getElenchusVersion(): Promise<string> {
	const engine = await loadEngine();
	if (!engine) return "";
	try {
		return engine.version();
	} catch {
		return "";
	}
}

/**
 * The companion skill bundled in elenchus-wasm (`SKILL.md`, byte-for-byte) and
 * its version marker — the engine version the skill targets. They ride in the
 * same package, so they are always in sync. Null if the engine is unavailable.
 */
export async function loadBundledElenchusSkill(): Promise<ElenchusSkill | null> {
	const engine = await loadEngine();
	if (!engine) return null;
	try {
		return { text: engine.skill(), version: engine.skillVersion() };
	} catch {
		return null;
	}
}
