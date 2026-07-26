import { describe, expect, it } from "vitest";
import {
	buildSdkCompatReport,
	evaluatePiVersionAdvisory,
	formatSdkCompatWarning,
	sdkCompatReportSignature,
} from "./sdk-compat";

// Minimal fakes exposing every surface the contract expects. Tests remove or
// corrupt individual surfaces to assert the probe reacts.
function goodApi(): Record<string, unknown> {
	return {
		on: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
	};
}

function goodCtx(): Record<string, unknown> {
	return {
		getContextUsage: () => undefined,
		compact: () => {},
		ui: {
			notify: () => {},
			editor: async () => undefined,
			confirm: async () => true,
		},
		sessionManager: {},
		cwd: "/project",
		waitForIdle: async () => {},
		switchSession: async () => ({ cancelled: false }),
	};
}

// Every fixture below is self-contained: TESTED is the range reports are built
// against, KNOWN sits inside it and UNKNOWN outside. Nothing here reads
// PLANNER_KNOWN_GOOD_PI_VERSIONS — the SDK watcher rewrites that constant on every
// Pi bump, and a fixture coupled to it silently flips meaning and reddens tests
// that have nothing to do with the SDK.
const TESTED = ["0.80"];
const KNOWN = "0.80.3";
const UNKNOWN = "0.99.0";

/** Build a report against {@link TESTED} rather than the shipped constant. */
function probe(input: {
	sdkVersion: string | null;
	api?: Record<string, unknown>;
	ctx?: Record<string, unknown>;
}) {
	return buildSdkCompatReport({
		sdkVersion: input.sdkVersion,
		api: input.api ?? goodApi(),
		ctx: input.ctx ?? goodCtx(),
		knownGood: TESTED,
	});
}

describe("evaluatePiVersionAdvisory", () => {
	it("treats a matching major.minor prefix as known", () => {
		expect(evaluatePiVersionAdvisory("0.80.3", ["0.80"])).toEqual({
			version: "0.80.3",
			known: true,
		});
		expect(evaluatePiVersionAdvisory("0.80", ["0.80"]).known).toBe(true);
	});

	it("treats an out-of-range version as unknown without erroring", () => {
		expect(evaluatePiVersionAdvisory("0.81.0", ["0.80"]).known).toBe(false);
		expect(evaluatePiVersionAdvisory("1.0.0", ["0.80"]).known).toBe(false);
	});

	it("matches any listed prefix, not just the first", () => {
		expect(evaluatePiVersionAdvisory("0.82.1", ["0.80", "0.82"]).known).toBe(
			true,
		);
		expect(evaluatePiVersionAdvisory("0.81.0", ["0.80", "0.82"]).known).toBe(
			false,
		);
	});

	it("does not partial-match a longer minor (0.8 vs 0.80)", () => {
		expect(evaluatePiVersionAdvisory("0.8.0", ["0.80"]).known).toBe(false);
	});

	it("treats null/empty as unknown", () => {
		expect(evaluatePiVersionAdvisory(null, ["0.80"])).toEqual({
			version: null,
			known: false,
		});
		expect(evaluatePiVersionAdvisory("", ["0.80"])).toEqual({
			version: null,
			known: false,
		});
	});
});

describe("buildSdkCompatReport", () => {
	it("reports ok with no findings when all surfaces are present", () => {
		const report = probe({ sdkVersion: KNOWN });
		expect(report.ok).toBe(true);
		expect(report.findings).toHaveLength(0);
		expect(report.criticalCount).toBe(0);
		expect(report.version.known).toBe(true);
	});

	it("evaluates the version against the injected range, not the constant", () => {
		// Guards the decoupling above: an explicit range must win, so a watcher
		// bump of PLANNER_KNOWN_GOOD_PI_VERSIONS cannot reach these tests.
		const report = buildSdkCompatReport({
			sdkVersion: "7.7.7",
			api: goodApi(),
			ctx: goodCtx(),
			knownGood: ["7.7"],
		});
		expect(report.version.known).toBe(true);
		expect(report.testedRange).toEqual(["7.7"]);
	});

	it("flags a missing critical ctx surface and marks the report not ok", () => {
		const ctx = goodCtx();
		delete ctx.compact;
		const report = probe({ sdkVersion: KNOWN, ctx });
		expect(report.ok).toBe(false);
		expect(report.criticalCount).toBe(1);
		const finding = report.findings.find((f) => f.path === "compact");
		expect(finding).toMatchObject({
			target: "ctx",
			status: "missing",
			actualType: "absent",
			severity: "critical",
		});
	});

	it("flags a wrong-type surface distinctly from a missing one", () => {
		const ctx = goodCtx();
		ctx.getContextUsage = 42;
		const report = probe({ sdkVersion: KNOWN, ctx });
		const finding = report.findings.find((f) => f.path === "getContextUsage");
		expect(finding).toMatchObject({
			status: "wrong_type",
			actualType: "number",
		});
	});

	it("treats a null surface as a wrong-type finding, not missing", () => {
		const ctx = goodCtx();
		ctx.sessionManager = null;
		const report = probe({ sdkVersion: KNOWN, ctx });
		const finding = report.findings.find((f) => f.path === "sessionManager");
		expect(finding).toMatchObject({ status: "wrong_type", actualType: "null" });
	});

	it("detects a missing nested surface when its parent object is gone", () => {
		const ctx = goodCtx();
		delete ctx.ui;
		const report = probe({ sdkVersion: KNOWN, ctx });
		const paths = report.findings.map((f) => f.path);
		expect(paths).toContain("ui");
		expect(paths).toContain("ui.notify");
		expect(paths).toContain("ui.editor");
	});

	it("keeps the report ok when only optional surfaces are missing", () => {
		const api = goodApi();
		delete api.sendMessage;
		const ctx = goodCtx();
		delete ctx.switchSession;
		const report = probe({ sdkVersion: KNOWN, api, ctx });
		expect(report.ok).toBe(true);
		expect(report.criticalCount).toBe(0);
		expect(report.optionalCount).toBe(2);
	});

	it("does not probe ctx.model (legitimately undefined at runtime)", () => {
		// A ctx without a `model` field must not produce any finding.
		const report = probe({ sdkVersion: KNOWN });
		expect(report.findings.some((f) => f.path.startsWith("model"))).toBe(false);
	});
});

describe("formatSdkCompatWarning", () => {
	it("returns null when everything is intact and the version is known", () => {
		expect(formatSdkCompatWarning(probe({ sdkVersion: KNOWN }))).toBeNull();
	});

	it("emits an info notice for an unknown-but-intact version", () => {
		const warning = formatSdkCompatWarning(probe({ sdkVersion: UNKNOWN }));
		expect(warning?.level).toBe("info");
		expect(warning?.message).toContain(UNKNOWN);
	});

	it("labels the tested range from the report, not the shipped constant", () => {
		const warning = formatSdkCompatWarning(
			buildSdkCompatReport({
				sdkVersion: UNKNOWN,
				api: goodApi(),
				ctx: goodCtx(),
				knownGood: ["0.80", "0.82"],
			}),
		);
		expect(warning?.message).toContain("0.80.x, 0.82.x");
	});

	it("emits a warning listing critical findings and the version context", () => {
		const ctx = goodCtx();
		delete ctx.compact;
		const warning = formatSdkCompatWarning(probe({ sdkVersion: UNKNOWN, ctx }));
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("ctx.compact");
		expect(warning?.message).toContain("outside the tested range");
	});

	it("warns (not info) when only optional surfaces are missing", () => {
		const api = goodApi();
		delete api.sendMessage;
		const warning = formatSdkCompatWarning(probe({ sdkVersion: KNOWN, api }));
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("optional");
	});
});

describe("sdkCompatReportSignature", () => {
	it("is stable for identical situations", () => {
		const a = probe({ sdkVersion: KNOWN });
		const b = probe({ sdkVersion: KNOWN });
		expect(sdkCompatReportSignature(a)).toBe(sdkCompatReportSignature(b));
	});

	it("changes when findings differ", () => {
		const intact = probe({ sdkVersion: KNOWN });
		const broken = goodCtx();
		delete broken.compact;
		const withFinding = probe({ sdkVersion: KNOWN, ctx: broken });
		expect(sdkCompatReportSignature(intact)).not.toBe(
			sdkCompatReportSignature(withFinding),
		);
	});

	it("changes when the version-known flag differs", () => {
		const known = probe({ sdkVersion: KNOWN });
		const unknown = probe({ sdkVersion: UNKNOWN });
		expect(sdkCompatReportSignature(known)).not.toBe(
			sdkCompatReportSignature(unknown),
		);
	});
});
