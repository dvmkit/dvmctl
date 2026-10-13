import { defineConfig } from "tsup";

export default defineConfig({ entry: ["src/cli/dvmctl.ts"], format: "esm", target: "node20", clean: true, minifyWhitespace: true, external: ["pg", "tsx", "@dvmkit/sdk", "@dvmkit/sdk/internal", "@dvmkit/sdk/server"], splitting: false, banner: { js: "#!/usr/bin/env node\nimport { createRequire as __dvmCreateRequire } from 'node:module';\nconst require = __dvmCreateRequire(import.meta.url);" } });
