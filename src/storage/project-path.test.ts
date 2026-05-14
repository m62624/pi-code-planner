import { describe, expect, it } from "vitest";
import { getProjectPlansDir, toProjectDirName } from "./project-path";

describe("project path helpers", () => {
	it("normalizes absolute project paths", () => {
		expect(toProjectDirName("/home/user/projects/app")).toBe(
			"home-user-projects-app",
		);
	});

	it("builds project plans directory", () => {
		expect(getProjectPlansDir("/agent/plans", "/home/user/app")).toBe(
			"/agent/plans/home-user-app",
		);
	});
});
