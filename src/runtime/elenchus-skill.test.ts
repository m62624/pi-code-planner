import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import { loadBundledElenchusSkill } from "./elenchus-engine";
import {
	BUNDLED_ELENCHUS_SKILL_NAME,
	ensureBundledElenchusSkillPath,
} from "./elenchus-skill";

const SKILL_PATH =
	"/agent/extensions/pi-code-planner/system-skills/elenchus/SKILL.md";
const MARKER_PATH =
	"/agent/extensions/pi-code-planner/system-skills/elenchus/.engine-version";

describe("bundled elenchus skill", () => {
	it("materializes the skill under a planner-namespaced name with a version marker", async () => {
		const fs = new MockPlannerFs();
		const skill = await loadBundledElenchusSkill();
		// elenchus-wasm is a dependency, so the engine is available here.
		expect(skill).not.toBeNull();

		const path = await ensureBundledElenchusSkillPath({
			fs,
			agentDir: "/agent",
		});
		expect(path).toBe(SKILL_PATH);

		const content = await fs.readText(SKILL_PATH);
		// Renamed away from `elenchus` so a host-installed skill cannot suppress it
		// (Pi's loadSkills is first-writer-wins; user dirs load before our paths).
		expect(content).toContain(`name: ${BUNDLED_ELENCHUS_SKILL_NAME}`);
		expect(content).not.toMatch(/^name: elenchus$/m);
		expect((await fs.readText(MARKER_PATH)).trim()).toBe(skill?.version);
	});

	it("rewrites when the stored engine version marker is stale", async () => {
		const fs = new MockPlannerFs();
		await fs.writeTextAtomic(SKILL_PATH, "---\nname: stale\n---\n# old\n");
		await fs.writeTextAtomic(MARKER_PATH, "0.0.0\n");

		const skill = await loadBundledElenchusSkill();
		await ensureBundledElenchusSkillPath({ fs, agentDir: "/agent" });

		const content = await fs.readText(SKILL_PATH);
		expect(content).toContain(`name: ${BUNDLED_ELENCHUS_SKILL_NAME}`);
		expect(content).not.toContain("name: stale");
		expect((await fs.readText(MARKER_PATH)).trim()).toBe(skill?.version);
	});
});
