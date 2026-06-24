import { describe, expect, it } from "vitest";
import { probeGitAvailability } from "./git-availability";
import type { GitRepoInput, GitRunner } from "./runner";

function makeRunner(overrides: Partial<GitRunner>): GitRunner {
	// Only the probe methods matter here; the rest are never called.
	return overrides as unknown as GitRunner;
}

describe("probeGitAvailability", () => {
	it("assumes git is present when the runner omits the probes", async () => {
		const result = await probeGitAvailability({
			git: makeRunner({}),
			projectRoot: "/repo/app",
		});
		expect(result).toEqual({ installed: true, repository: true });
	});

	it("reports git missing and skips the repository check", async () => {
		let repoChecked = false;
		const result = await probeGitAvailability({
			git: makeRunner({
				isInstalled: async () => false,
				isRepository: async () => {
					repoChecked = true;
					return true;
				},
			}),
			projectRoot: "/repo/app",
		});
		expect(result).toEqual({ installed: false, repository: false });
		expect(repoChecked).toBe(false);
	});

	it("reports installed-but-no-repository", async () => {
		const seen: GitRepoInput[] = [];
		const result = await probeGitAvailability({
			git: makeRunner({
				isInstalled: async () => true,
				isRepository: async (input) => {
					seen.push(input);
					return false;
				},
			}),
			projectRoot: "/repo/app",
		});
		expect(result).toEqual({ installed: true, repository: false });
		expect(seen).toEqual([{ repoRoot: "/repo/app" }]);
	});

	it("reports installed-and-repository", async () => {
		const result = await probeGitAvailability({
			git: makeRunner({
				isInstalled: async () => true,
				isRepository: async () => true,
			}),
			projectRoot: "/repo/app",
		});
		expect(result).toEqual({ installed: true, repository: true });
	});
});
