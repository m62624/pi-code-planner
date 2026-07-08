import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The load-bearing property of the whole reasoning-fuel redesign: fuel is
 * TONE-ONLY. Its level must not enter any allow/block decision anywhere — the
 * only floors are on named terminal defects (a CONFLICT verdict, an
 * un-CONSISTENT gate), never on how much fuel there is.
 *
 * We enforce this structurally: the modules that decide what is allowed,
 * blocked, gated, or transitionable must not import the fuel modules at all. If
 * a decision cannot even see fuel, it cannot key on it. Break the property —
 * import a fuel module into any decision path — and this test fails.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The modules that produce or shape the fuel level.
const FUEL_MODULES = ["reasoning-fuel", "reason-context", "reason-directive"];

// Every module that decides allow / block / gate / transition.
const DECISION_MODULES = [
	"guard/tool-policy.ts",
	"runtime/orchestrator.ts",
	"runtime/orchestrator-gate.ts",
	"runtime/workflow-tools.ts",
	"runtime/gate-tools.ts",
	"runtime/state-machine.ts",
	"runtime/state-transition.ts",
];

// The only non-test modules allowed to import a fuel module — the surfacing
// layer (the reason tool and the status text), plus the fuel graph itself.
const ALLOWED_FUEL_IMPORTERS = new Set([
	"runtime/reason-context.ts",
	"runtime/reason-directive.ts",
	"runtime/reason-tools.ts",
	"runtime/status.ts",
]);

function importsAnyFuelModule(source: string): boolean {
	return FUEL_MODULES.some((mod) =>
		new RegExp(`from\\s+"[^"]*${mod}"`).test(source),
	);
}

describe("fuel is tone-only — it enters no allow/block decision", () => {
	it("no decision module imports a fuel module", () => {
		for (const rel of DECISION_MODULES) {
			const source = readFileSync(join(SRC_ROOT, rel), "utf8");
			expect(
				importsAnyFuelModule(source),
				`${rel} must not import a fuel module — fuel is tone-only and cannot gate`,
			).toBe(false);
		}
	});

	it("only the surfacing layer imports a fuel module", () => {
		const offenders: string[] = [];
		for (const file of walkTsFiles(SRC_ROOT)) {
			const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
			if (rel.endsWith(".test.ts")) continue;
			if (FUEL_MODULES.some((mod) => rel.endsWith(`${mod}.ts`))) continue;
			if (ALLOWED_FUEL_IMPORTERS.has(rel)) continue;
			if (importsAnyFuelModule(readFileSync(file, "utf8"))) offenders.push(rel);
		}
		expect(
			offenders,
			"unexpected fuel importers outside the surfacing layer",
		).toEqual([]);
	});
});

function* walkTsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTsFiles(full);
		} else if (entry.name.endsWith(".ts")) {
			yield full;
		}
	}
}
