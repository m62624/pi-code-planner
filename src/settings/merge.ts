import type { PartialPlannerSettings, PlannerSettings } from "./schema";

export function mergePlannerSettings(
	base: PlannerSettings,
	override: PartialPlannerSettings,
): PlannerSettings {
	return {
		...base,
		instructions: {
			...base.instructions,
			...(override.instructions ?? {}),
		},
		refactor: {
			...base.refactor,
			...(override.refactor ?? {}),
		},
		git: {
			...base.git,
			...(override.git ?? {}),
			branchNaming: {
				...base.git.branchNaming,
				...(override.git?.branchNaming ?? {}),
			},
		},
		verificationCommands:
			override.verificationCommands ?? base.verificationCommands,
	};
}
