# Component systems and registries

Read this when the task may reuse, adapt, import, generate, or create components. A component library, registry, MCP server, package, or design-system repository supplies implementation material. It does not choose art direction or information architecture.

## Follow the decision order

1. Inspect incumbent components, tokens, styling, registries, and repository conventions.
2. Determine required behavior and accessibility.
3. Establish information architecture.
4. Establish the visual thesis.
5. Reuse or adapt appropriate components.
6. Create a new component only when the incumbent system cannot cleanly express required behavior.

Originality should come primarily from composition, typography, content, visual language, imagery, material, interaction choreography, and product-specific signatures. Do not hand-build complex behavior merely to make an interface look unique.

## Prefer proven behavior

Prefer proven accessible primitives for dialogs, menus, comboboxes, selects, tabs, disclosure, tooltips, date inputs, data tables, drag-and-drop, focus traps, and virtualized collections. Verify semantics, keyboard behavior, focus restoration, screen-reader output, touch behavior, reduced motion, and controlled or uncontrolled state against the actual product need.

A primitive may be structurally suitable while its default styling is wrong. Adapt presentation inside the selected thesis rather than replacing accessible behavior.

## Admit a registry conditionally

Do not introduce shadcn, Material, or another component system because it is available. Use registry material only when compatible with the existing framework, styling and tokens, accessibility requirements, bundle and runtime constraints, license, maintenance model, and repository conventions.

Inspect imported or generated source before accepting it. Preview the diff. Preserve incumbent behavior and reject unrelated files, dependencies, configuration, or global styles. Registry availability must never determine art direction.

When external execution, installation, network access, or repository transmission is involved, also read [../../design/references/external-dependencies.md](../../design/references/external-dependencies.md). Missing registry or MCP capability does not block the workflow; use incumbent components or write the smallest local component that satisfies the established contract.

## Keep ownership explicit

`frontend-design` owns the thesis and information architecture. `frontend-components` owns composable structure and state boundaries. Framework specialists own implementation performance. Accessibility may veto behavior that fails users. None may silently replace the art direction.
