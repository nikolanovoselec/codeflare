/**
 * Shared Zod schemas used across multiple route files.
 * Avoids duplication of validation logic.
 */

// Single source of truth for TabConfigSchema lives in the web-ui copy
// (web-ui/src/lib/schemas.ts). That module is pure Zod with no DOM/Solid/Hono
// dependencies, so the Workers runtime bundle (and the Workers test pool) can
// import it directly via relative path - the same resolution the cross-tier
// parity guard already relies on (src/__tests__/contract/schemas.test.ts).
// Re-exporting here keeps the worker's import sites unchanged while collapsing
// the duplicated object definition to one canonical place (CF-018, CF-010).
export { TabConfigSchema } from '../../web-ui/src/lib/schemas';
