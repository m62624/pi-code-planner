// The bundled elenchus premise-template library ("vrf templates"): curated
// first-principles libraries the model IMPORTs from its own .vrf program and
// feeds with facts + VAR port values. The model can only err at the fact
// level — the vetted premises come from here.

export const VRF_TEMPLATE_NAMES = [
	"spec-consistency",
	"plan-consistency",
	"tdd-gate",
	"branch-contract",
	"doubt-review",
	"discovery-gaps",
	"recovery-state",
	"ship-gate",
] as const;

export type VrfTemplateName = (typeof VRF_TEMPLATE_NAMES)[number];

export type VrfTemplateContents = Record<VrfTemplateName, string>;

export interface SyncedVrfTemplate {
	name: VrfTemplateName;
	/** Where the template was materialized inside the plan's elenchus dir. */
	targetPath: string;
	/** Whether the bundled default or a project override supplied the content. */
	source: "bundled" | "project";
	action: "created" | "updated" | "unchanged";
}
