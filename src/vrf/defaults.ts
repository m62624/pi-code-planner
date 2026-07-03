import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannerFs } from "../storage/fs";
import { vrfTemplateFilePath } from "./paths";
import {
	VRF_TEMPLATE_NAMES,
	type VrfTemplateContents,
	type VrfTemplateName,
} from "./schema";

export const BUNDLED_VRF_DEFAULTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"vrf",
	"defaults",
);

export async function loadBundledVrfTemplates(
	fs: PlannerFs,
	defaultsDir = BUNDLED_VRF_DEFAULTS_DIR,
): Promise<VrfTemplateContents> {
	const contents = {} as VrfTemplateContents;
	for (const name of VRF_TEMPLATE_NAMES) {
		contents[name] = await fs.readText(vrfTemplateFilePath(defaultsDir, name));
	}
	return contents;
}

export function isVrfTemplateName(value: string): value is VrfTemplateName {
	return (VRF_TEMPLATE_NAMES as readonly string[]).includes(value);
}
