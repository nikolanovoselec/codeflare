# Operate surfaces and dashboards

Read this for dashboards, consoles, internal tools, monitoring, investigation, triage, configuration, approval, comparison, and bulk-action workflows. This reference owns operational information design. `frontend-design` retains visual art direction; framework specialists retain implementation engineering.

## Establish the operating job

Before selecting components, determine:

- who operates the interface, their expertise, and usage frequency;
- the decision they must make and the action that follows;
- whether they monitor, investigate, compare, triage, configure, approve, or act in bulk;
- which information is urgent, actionable, contextual, or merely available;
- expected data volume, update frequency, and whether data may be partial, delayed, stale, conflicting, or permission-limited.

Expert daily operation can justify compact density, persistent controls, keyboard paths, and precise comparison. Occasional management review needs stronger summaries, explanation, and safer disclosure. Do not give both users the same dashboard with larger padding.

## Structure decisions before widgets

Define the primary scan path, information hierarchy, grouping and adjacency, density, global versus local scope, time range, and comparison context. Then define filtering, sorting, search, drill-down and return behavior, selection and bulk actions, saved views, thresholds, exceptions, state persistence, and auditability where applicable.

Keep scope visible. Users must know whether a metric, filter, selection, or action applies globally, to one account, to one time range, or to the current result set. Preserve investigation context through drill-down and return.

Choose representations from the user's question:

- summary value for current status;
- table for precise lookup, ranking, comparison, and action;
- chart for trend, distribution, correlation, or anomaly;
- timeline for event sequence;
- topology or graph for relationships;
- text when it communicates the result more accurately than visualization.

Do not turn every metric into a card or every dataset into a chart. Map coherent information architecture to components only after these decisions hold together.

## Design operational states

Explicitly design loading, partial data, stale data, empty results, errors, permission-limited data, disconnected or degraded operation, optimistic and confirmed actions, destructive confirmation, and undo or recovery where appropriate.

A stale value needs timestamp and consequence, not only a muted color. Partial or permission-limited data must not masquerade as zero. Optimistic actions need visible pending ownership and a defined failure path. Destructive actions need scope, consequence, and recovery stated before confirmation.

## Adapt the job for smaller screens

Preserve the primary operational job instead of stacking the desktop dashboard into a long narrow page. Prioritize urgent decisions and frequent actions. Use summaries, focused views, progressive disclosure, and deliberately reduced scope when necessary. Keep drill-down and return orientation intact.

If the full operational job cannot work safely on the smaller platform, state that limitation and design a bounded mobile job rather than a miniature control room.

## Validate the workflow

Use realistic volume and update cadence. Exercise filtering, selection, bulk action, drill-down, backtracking, keyboard flow, stale and partial data, permission loss, failed actions, and narrow-screen prioritization. Verify that expert and occasional-user variants differ in density and explanation because their work differs, not because one received a cosmetic theme.
