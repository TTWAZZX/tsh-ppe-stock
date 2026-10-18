# Project Guardrails

## Layout width is a locked project standard

The shared page-width system is already approved. Do not change, remove, or bypass it while implementing or reviewing a feature unless the user explicitly requests a new global layout standard.

- This rule applies to every user and admin module.
- Keep each top-level module inside the existing `.page-container > .page > .module-shell` layout contract.
- The module shell must remain full width within the main content area. Do not add inner `max-w-*`, fixed `width`, or narrow centering wrappers that make one module narrower than the others.
- Feature cards, forms, tables, and empty states may have their own responsive layouts, but their outer module container must use the shared width and gutters.
- Do not modify the shared sidebar width, main-content offset, `.page-container`, `.page`, `.module-shell`, or their responsive breakpoints as a side effect of module work.
- Reuse the existing responsive rules instead of adding module-specific page-width overrides.
- Before finishing any UI change, compare the edited module with at least one existing user module and one admin module at desktop width.
- Verify at minimum at 1920px desktop and 390px mobile widths. The page must have no horizontal overflow, clipping, or accidental narrow container.
- If a requested feature truly requires changing this standard, stop and explain the project-wide impact before editing it.

Changes confined to content layout inside a module are allowed as long as the outer shared width remains unchanged.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
