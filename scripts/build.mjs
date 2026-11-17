import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// One self-contained file: the vendored core and every dependency are inside,
// so the published package installs nothing at runtime.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "build/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __zerroCreateRequire } from 'node:module';\nconst require = __zerroCreateRequire(import.meta.url);",
  },
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: "eof",
  logLevel: "info",
});
