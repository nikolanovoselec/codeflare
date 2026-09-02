# Spec-driven development

Codeflare can turn an objective into a requirements system that remains connected to implementation and verification. An SDD requirement records intent, acceptance criteria, constraints, priority, dependencies, evidence anchors, and status. That gives an autonomous agent a contract it can check instead of a paragraph it can reinterpret after three hours of coding.

Advanced sessions carry the SDD workflows. `/sdd init` can bootstrap a new, legacy, or partially specified repository. Ongoing work updates the owning requirement before implementation, writes a failing behavioral test first when one is justified, and keeps implementation and verification anchors current. Touched requirements do not get left `Partial` when the work is claimed complete.

Try it in an Advanced session:

1. Run `/sdd init` in a repository that does not yet have `sdd/`.
2. Ask for a feature with observable acceptance criteria.
3. Inspect the resulting requirement and verify that its implementation and test anchors point to real owners.

For an existing Codeflare-style SDD repository, ask: "Trace this change to its owning REQ and tell me which acceptance criteria would fail before the fix." That forces contract discovery before mutation.

SDD does not make every prose sentence executable. Subjective design and managed-skill quality remain human-reviewed where source matching would only pin wording.

Source anchors: `sdd/README.md`, `sdd/spec/agents.md` REQ-AGENT-021/033/034/045, and `documentation/lanes/preseed.md#sdd-bootstrap-contract`.
