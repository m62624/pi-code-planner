import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import { ARTIFACT_CANONICAL_SCHEMA } from "./artifact-echo";
import {
	buildDiscoveryMarkdown,
	PLANNER_ARTIFACT_TOOL_NAMES,
	stripVerificationProtocolSection,
} from "./artifact-tools";
import {
	extractVerificationProtocol,
	extractVerificationProtocolCommands,
} from "./doubt-review";
import {
	validatePostImplementationCounterexampleReview,
	validatePreImplementationProofContract,
	validateTaskMergeScopeAudit,
} from "./tdd-evidence";
import { mergeTddMarkdown, renderTddSection, TDD_SECTIONS } from "./tdd-form";

// Reproduces the deadlock from the decoded pi-session: the model wrote its own
// "## Verification Protocol" section (with a prose lead-in and extra commands)
// into the discovery body while the wrapper also appended one from the
// verificationProtocol argument. The parser then collected the prose line as a
// phantom required command, so planner_doubt_review could never be satisfied.
describe("discovery_submit ↔ verification protocol parser round-trip", () => {
	it("keeps the verificationProtocol argument as the single source of truth", () => {
		const body = [
			"# Discovery: example",
			"",
			"## Findings",
			"- everything already has AGENTS.md except src/test/",
			"",
			"### Verification Protocol",
			"The existing project has these commands available:",
			"- `npm run check` — biome",
			"- `npm run build` — tsc",
			"- `npm test` — vitest",
			"- `npm run ci` — full pipeline",
			"- `npm run format` — biome format",
		].join("\n");

		const discoveryMd = buildDiscoveryMarkdown(body, [
			"npm run check",
			"npm run build",
			"npm test",
		]);

		// Exactly one protocol section survives, and it is the argument's.
		const headings = discoveryMd
			.split(/\r?\n/)
			.filter(
				(line) => /verification protocol/i.test(line) && /^#{1,6}\s/.test(line),
			);
		expect(headings).toEqual(["## Verification Protocol"]);

		// The parser the doubt_review gate uses returns exactly the argument
		// commands — no prose phantom, no ci/format the model never ran.
		expect(extractVerificationProtocolCommands(discoveryMd)).toEqual([
			"npm run check",
			"npm run build",
			"npm test",
		]);
	});

	it("ignores prose lines under a verification protocol heading", () => {
		const discoveryMd = [
			"# Discovery",
			"",
			"## Verification Protocol",
			"The existing project has these commands available:",
			"- npm run check",
			"- npm test",
		].join("\n");
		// The prose lead-in is dropped; only bullet commands remain.
		expect(extractVerificationProtocol(discoveryMd)).toEqual([
			"- npm run check",
			"- npm test",
		]);
		expect(extractVerificationProtocolCommands(discoveryMd)).toEqual([
			"npm run check",
			"npm test",
		]);
	});

	it("strips a body protocol section regardless of heading level", () => {
		for (const heading of [
			"## Verification Protocol",
			"#### Verification Protocol",
		]) {
			const stripped = stripVerificationProtocolSection(
				["## Findings", "- a", heading, "- npm run lint"].join("\n"),
			);
			expect(stripped).not.toMatch(/verification protocol/i);
			expect(stripped).not.toContain("npm run lint");
			expect(stripped).toContain("## Findings");
		}
	});
});

describe("tdd_submit ↔ tdd-evidence validators round-trip", () => {
	it("renders sections that the consuming validators accept", async () => {
		const updates = Object.fromEntries(
			TDD_SECTIONS.map((def) => [
				def.key,
				renderTddSection(
					def,
					Object.fromEntries(
						def.fields.map((field) => [field, `concrete ${field} evidence`]),
					),
				),
			]),
		);
		const content = mergeTddMarkdown(
			"",
			updates as Parameters<typeof mergeTddMarkdown>[1],
		);

		const fs = new MockPlannerFs();
		const path = "/plan/tasks/task-1/tdd.md";
		await fs.writeTextAtomic(path, content);

		await expect(
			validatePreImplementationProofContract(fs, path),
		).resolves.toBeNull();
		await expect(
			validatePostImplementationCounterexampleReview(fs, path),
		).resolves.toBeNull();
		await expect(validateTaskMergeScopeAudit(fs, path)).resolves.toBeNull();
	});
});

describe("fill-tool echo schema", () => {
	it("provides a canonical schema for every artifact tool", () => {
		for (const tool of PLANNER_ARTIFACT_TOOL_NAMES) {
			expect(ARTIFACT_CANONICAL_SCHEMA[tool]?.trim().length).toBeGreaterThan(0);
		}
	});
});
