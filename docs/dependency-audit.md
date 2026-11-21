# Dependency audit record

On November 21, 2026, we ran `npm audit --json` and `npm audit --omit=dev --json` after clean installs with Node 22.23.2 and npm 10.9.8. The baseline was [the CLI revision with SDK 0.40.0](https://github.com/dvmkit/dvmctl/commit/525db769e6685df8de0c0842b2079c8d1a192802).

| Graph | Baseline | After the update |
| --- | --- | --- |
| Repository, full | 15 entries (3 high, 11 moderate, 1 low) | 1 low |
| Repository, production only | 0 | 0 |
| Fresh install of the packed CLI, production only | | 0 |
| Fresh generated scaffold, full and production only | | 0 in each |

Counts include affected parent packages when npm reports them. Lockfile-only runs with npm's cache disabled reported 22 full entries before the update and eight after it, with the same underlying advisories as the clean-install runs.

## Runtime

[The SDK pin upgrade](https://github.com/dvmkit/dvmctl/pull/82) already resolved the advisories reported against the previous pin. [`dvmctl serve`](../src/commands/builder/serve.ts) and [`dvmctl dev`](../src/lib/serve-dev.ts) use the pinned SDK server, and [the generated scaffold](../src/commands/builder/create/templates/shared.ts) installs the same exact SDK version.

- **x402 and Zod.** The SDK uses x402 to handle requests on payment-enabled routes. The older x402 packages brought nested Zod 3 into that runtime path. The advisory concerns validation of oversized constrained collections. SDK 0.40.0 selects x402 core and EVM 2.31.0 with Zod 4.6.7, which includes the fix. [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- **Hono routing and helpers.** The SDK creates a Hono app for serving requests, so router and middleware advisories apply to the HTTP surface where the affected routing features are used. The HTML, CSRF, and form validation advisories require their respective helpers, which are outside the built-in CLI serving path. SDK 0.40.0 pins Hono 4.13.18, which addresses all five advisories. [Mount routing](https://github.com/advisories/GHSA-4m76-xfj5-7975), [wildcard middleware](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [HTML helper](https://github.com/advisories/GHSA-3gg2-335m-rxc6), [CSRF middleware](https://github.com/advisories/GHSA-46wx-v44x-9hh2), [form validator](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v)
- **Hono Node adapter.** The SDK calls the adapter's `serve` with its app's request handler. Proxy path handling can therefore matter when a service runs behind a reverse proxy. The static-file advisory requires `serveStatic`, which is outside this serving path. SDK 0.40.0 pins adapter 2.1.8, which addresses both advisories. [Proxy path handling](https://github.com/advisories/GHSA-jpvv-r467-5p4w), [static files](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)

## Development tooling

| Dependency and workflow | Disposition |
| --- | --- |
| **Vitest mocker.** Repository and scaffold tests run `vitest run`. The affected mock registration and redirect handlers are browser-mode features. | Repository Vitest and its mocker resolve to 5.1.1. A fresh scaffold resolves the same version through its existing Vitest 5 range. [Mock registration](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Windows redirect handling](https://github.com/advisories/GHSA-xp26-3454-mjgp) |
| **Vite.** Vitest brings Vite into the test toolchain. The advisories affect development-server features such as launching an editor, custom middleware, and serving files. The CLI serves DVMs through the SDK. | Vite resolves to 8.3.8 in both the repository and the fresh scaffold. [Windows argument escaping](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [editor flags](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [Windows path validation](https://github.com/advisories/GHSA-587h-7wmj-h5pm), [custom middleware](https://github.com/advisories/GHSA-9jrq-w75r-8gcw), [file serving](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [WebAssembly file serving](https://github.com/advisories/GHSA-vfpm-58rq-9qcg) |
| **Minimatch and brace-expansion.** ESLint and typescript-eslint use these packages for glob matching in the authoring and CI lint workflow. The reported denial-of-service conditions require crafted patterns. | ESLint 10.15.0 and typescript-eslint 8.73.0 select minimatch 11.0.9 and brace-expansion 5.0.13. [Minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [expansion cost](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [nested groups](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [comma parsing](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) |
| **Source Map JS.** PostCSS brings the parser into the build and test toolchain. The affected operation parses indexed source maps. | The repository lockfile resolves `source-map-js` 1.2.4. [Indexed source-map parsing](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| **esbuild.** The development lockfile retains 0.27.7. The advisory requires running esbuild's own development server on Windows. The CLI's [optional `tsx` loader](../src/lib/load-handler.ts) registers a module transform for local handlers. | The Windows development-server advisory is tracked separately. The fresh packed CLI install resolved optional `tsx` 4.23.15 with esbuild 0.28.2 and reported zero production entries. [Windows development server](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) |
