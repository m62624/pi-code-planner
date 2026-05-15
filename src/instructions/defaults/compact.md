# discovery_compact_required

Request planner-controlled compaction for discovery. The compact instruction should preserve the discovery result, project memory assumptions, open questions, risks, and the next stage.

Post-compact resume must tell the model to reload the active plan artifacts and compressed memory before continuing with post-discovery questions.

# work_item_compact_required

Request planner-controlled compaction for the completed atomic work item. The compact instruction should preserve the work item result, selected candidate, verification, memory refresh status, and next-unit selection context.

Post-compact resume must tell the model to reload the active plan, completed work item artifacts, and compressed memory before selecting the next unit.

# details

Compact is a boundary, not an implementation stage. Do not edit code while compact is required or pending.
