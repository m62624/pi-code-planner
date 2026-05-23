import type { InstructionDefaults } from "./schema";

export const DEFAULT_INSTRUCTIONS: InstructionDefaults = {
	init: "# init\n",
	discovery: "# discovery\n",
	planning: "# planning\n",
	execution: "# execution\n",
	finalize: "# finalize\n",
	done: "# done\n",
	recovery: "# recovery\n",
	tdd: "# tdd\n",
	experiment: "# experiment\n",
	refactor: "# refactor\n",
	memory: "# memory\n",
	git: "# git\n",
	"git-commit": "# git-commit\n",
};
