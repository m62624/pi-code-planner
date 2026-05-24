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
	memory: `# memory

Memory is the compressed project knowledge base. It must stay aligned with the current files before compact, stage transition, task completion, merge, or user review.

When memory update is required, inspect only the affected files first. Use bounded memory retrieval for related context before reading broad source files.

For every changed or new file, update:
- file index entry
- symbol/signature entries
- relation entries
- effects for every affected symbol

Effects are mandatory. Do not only update signatures or summaries.

For each affected symbol, re-evaluate:
- whether it reads external or global state
- whether it writes external or global state
- filesystem, network, process, environment, time, random, database, or UI IO
- calls to other side-effectful symbols
- hidden behavior changes that can affect tests or callers

If effects are unclear, set globalState to "unknown" and record the uncertainty in summary or questions. Do not guess "none" without evidence.

After updating memory, verify that file hashes and symbol anchors match the current source. Only then can planner sync the memory checkpoint to the current git HEAD.
`,
	git: "# git\n",
	"git-commit": "# git-commit\n",
};
