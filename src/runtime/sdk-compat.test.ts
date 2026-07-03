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

const KNOWN = "0.80.3";

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
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		expect(report.ok).toBe(true);
		expect(report.findings).toHaveLength(0);
		expect(report.criticalCount).toBe(0);
		expect(report.version.known).toBe(true);
	});

	it("flags a missing critical ctx surface and marks the report not ok", () => {
		const ctx = goodCtx();
		delete ctx.compact;
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx,
		});
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
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx,
		});
		const finding = report.findings.find((f) => f.path === "getContextUsage");
		expect(finding).toMatchObject({
			status: "wrong_type",
			actualType: "number",
		});
	});

	it("treats a null surface as a wrong-type finding, not missing", () => {
		const ctx = goodCtx();
		ctx.sessionManager = null;
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx,
		});
		const finding = report.findings.find((f) => f.path === "sessionManager");
		expect(finding).toMatchObject({ status: "wrong_type", actualType: "null" });
	});

	it("detects a missing nested surface when its parent object is gone", () => {
		const ctx = goodCtx();
		delete ctx.ui;
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx,
		});
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
		const report = buildSdkCompatReport({ sdkVersion: KNOWN, api, ctx });
		expect(report.ok).toBe(true);
		expect(report.criticalCount).toBe(0);
		expect(report.optionalCount).toBe(2);
	});

	it("does not probe ctx.model (legitimately undefined at runtime)", () => {
		// A ctx without a `model` field must not produce any finding.
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		expect(report.findings.some((f) => f.path.startsWith("model"))).toBe(false);
	});
});

describe("formatSdkCompatWarning", () => {
	it("returns null when everything is intact and the version is known", () => {
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		expect(formatSdkCompatWarning(report)).toBeNull();
	});

	it("emits an info notice for an unknown-but-intact version", () => {
		const report = buildSdkCompatReport({
			sdkVersion: "0.99.0",
			api: goodApi(),
			ctx: goodCtx(),
		});
		const warning = formatSdkCompatWarning(report);
		expect(warning?.level).toBe("info");
		expect(warning?.message).toContain("0.99.0");
	});

	it("emits a warning listing critical findings and the version context", () => {
		const ctx = goodCtx();
		delete ctx.compact;
		const report = buildSdkCompatReport({
			sdkVersion: "0.99.0",
			api: goodApi(),
			ctx,
		});
		const warning = formatSdkCompatWarning(report);
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("ctx.compact");
		expect(warning?.message).toContain("outside the tested range");
	});

	it("warns (not info) when only optional surfaces are missing", () => {
		const api = goodApi();
		delete api.sendMessage;
		const report = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api,
			ctx: goodCtx(),
		});
		const warning = formatSdkCompatWarning(report);
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("optional");
	});
});

describe("sdkCompatReportSignature", () => {
	it("is stable for identical situations", () => {
		const a = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		const b = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		expect(sdkCompatReportSignature(a)).toBe(sdkCompatReportSignature(b));
	});

	it("changes when findings differ", () => {
		const intact = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		const broken = goodCtx();
		delete broken.compact;
		const withFinding = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: broken,
		});
		expect(sdkCompatReportSignature(intact)).not.toBe(
			sdkCompatReportSignature(withFinding),
		);
	});

	it("changes when the version-known flag differs", () => {
		const known = buildSdkCompatReport({
			sdkVersion: KNOWN,
			api: goodApi(),
			ctx: goodCtx(),
		});
		const unknown = buildSdkCompatReport({
			sdkVersion: "0.99.0",
			api: goodApi(),
			ctx: goodCtx(),
		});
		expect(sdkCompatReportSignature(known)).not.toBe(
			sdkCompatReportSignature(unknown),
		);
	});
});
