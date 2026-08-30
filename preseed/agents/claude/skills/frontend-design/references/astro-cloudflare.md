# Astro and Cloudflare

Read this only when the repository already uses Astro or the task explicitly considers Astro for a new Cloudflare-targeted frontend.

Astro can fit content-heavy marketing and reading surfaces, but it is not a universal design choice. Preserve the existing framework and deployment model unless change is authorized.

## Confirm the actual stack

Inspect installed Astro, integration, adapter, and Cloudflare package versions. Use current official documentation for those versions when available. When current official documentation is unavailable, rely on installed metadata, types, package sources, and established repository behavior; state the verification limit and avoid uncertain version-specific changes. Distinguish static output from on-demand rendering before choosing data access, caching, or runtime APIs.

## Keep the default static

Prefer semantic HTML, CSS, and lightweight scripts before hydration. Hydrate supported framework components only when interaction requires it, at a priority justified by the user path.

Astro's `client:visible` hydrates supported framework components when they become visible. It is not a generic media-loading mechanism. Use appropriate HTML loading behavior and lifecycle-managed scripts for video, canvas, WebGL, and DOM animation.

Initialize expensive work only when needed. Pause it when hidden or offscreen where appropriate. Cancel callbacks, disconnect observers, remove listeners, stop media, and release graphics resources during teardown.

## Handle images and media correctly

Use the project's image pipeline for optimizable source assets. Files in `public/` are normally copied without image processing. Do not lazy-load the likely LCP image. Reserve intrinsic space, provide responsive sources where appropriate, and keep oversized media out of unsuitable Worker bundles.

For video and persistent animation, follow [assets-and-motion.md](assets-and-motion.md). Hydration priority does not replace media lifecycle design.

## Preserve deployment truth

Check adapter output, runtime bindings, asset limits, caching, and route behavior against the actual Cloudflare target. Do not change static versus on-demand rendering, add a runtime dependency, or move media into deployment artifacts without authorization and measured need.
