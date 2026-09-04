# Specification discipline

Applies only when `sdd/` exists.

- `/sdd init`, `/sdd edit`, or `/sdd add`: load `spec-driven-development`.
- `/sdd clean` or PR-boundary specification review: load `spec-enforce`, whose 24-row manifest delegates AC and truth checks to `spec-enforce-ac` and `spec-enforce-truth`.

Boundary reviewers run together and return reports without mutation; root performs triage and accepted fixes. `/sdd clean` instead applies specification fixes before documentation checks because documentation depends on the corrected specification.

Skipping required specification enforcement is HIGH `enforcement-skill-not-invoked`.
