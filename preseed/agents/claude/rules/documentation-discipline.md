# Documentation discipline

Applies only when both `sdd/` and `documentation/` exist.

For `/sdd clean` or PR-boundary documentation review, load `doc-enforce`. Its 16-row manifest delegates lane, shape, and truth checks to `doc-enforce-lanes`, `doc-enforce-shape`, and `doc-enforce-truth` when applicable.

Boundary documentation review launches with the other required lanes and returns a report without mutation. `/sdd clean` checks documentation after applying specification fixes.

Skipping required documentation enforcement is HIGH `enforcement-skill-not-invoked`.
