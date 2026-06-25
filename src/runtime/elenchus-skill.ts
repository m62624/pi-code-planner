import { join } from "node:path";
import { EXTENSION_NAME } from "../constants/extension";
import type { PlannerFs } from "../storage/fs";
import { loadBundledElenchusSkill } from "./elenchus-engine";

// The bundled elenchus skill is served under a planner-namespaced name so it
// never collides with a host-installed `elenchus` skill. Pi's loadSkills is
// first-writer-wins and loads user/project skill dirs BEFORE extension-provided
// skillPaths, so a same-named host skill would otherwise suppress ours. A
// distinct name guarantees the wasm-matched skill is always served; the planner
// tool and stage instructions point the model at this one.
export const BUNDLED_ELENCHUS_SKILL_NAME = "pi-planner-elenchus";

function bundledSkillDir(agentDir: string): string {
	// System skill: lives in its own top-level system-skills/ dir, kept entirely
	// apart from the per-project user skills (projects/<id>/skills). It is not
	// model-generated, not in any skill index, not subject to maxActive
	// truncation, and not editable through the planner-skills UI. The dedicated
	// top-level name avoids confusing it with a project's own skills.
	return join(
		agentDir,
		"extensions",
		EXTENSION_NAME,
		"system-skills",
		"elenchus",
	);
}

/** Replace the frontmatter `name:` so the served skill is planner-namespaced. */
function rewriteSkillName(text: string, name: string): string {
	return text.replace(/^name:.*$/m, `name: ${name}`);
}

/**
 * Materialize the elenchus skill bundled inside `elenchus-wasm` (byte-for-byte
 * `skill()`, renamed to {@link BUNDLED_ELENCHUS_SKILL_NAME}) into the planner's
 * bundled skill dir, and return its path. Rewritten only when missing or when
 * the engine's `skillVersion()` changed (the skill and engine ship in the same
 * package, so the marker tracks the installed version). Returns null when the
 * engine is unavailable, so callers can fall back to the user skills.
 */
export async function ensureBundledElenchusSkillPath(input: {
	fs: PlannerFs;
	agentDir: string;
}): Promise<string | null> {
	const skill = await loadBundledElenchusSkill();
	if (!skill) return null;
	const dir = bundledSkillDir(input.agentDir);
	const skillPath = join(dir, "SKILL.md");
	const markerPath = join(dir, ".engine-version");
	const marker = (await input.fs.exists(markerPath))
		? (await input.fs.readText(markerPath)).trim()
		: null;
	if (marker !== skill.version || !(await input.fs.exists(skillPath))) {
		await input.fs.writeTextAtomic(
			skillPath,
			rewriteSkillName(skill.text, BUNDLED_ELENCHUS_SKILL_NAME),
		);
		await input.fs.writeTextAtomic(markerPath, `${skill.version}\n`);
	}
	return skillPath;
}
