import { build } from "esbuild";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// One self-contained file: the vendored core and every dependency are inside,
// so the published package installs nothing at runtime.
const { metafile } = await build({
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
  metafile: true,
  logLevel: "info",
});

// The license texts of the npm packages actually bundled, which their licenses ask to keep.
const packages = new Set(
  Object.keys(metafile.inputs)
    .map(path => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1])
    .filter(Boolean),
);
const notices = [...packages].sort().map(name => {
  const dir = join("node_modules", name);
  const file = readdirSync(dir).find(f => /^(licen[cs]e|copying)/i.test(f));
  if (!file) throw new Error(`No license file in ${dir}`);
  const { version: v } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return `## ${name}@${v}\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
});
writeFileSync("build/THIRD_PARTY_LICENSES.md", `# Third-party licenses\n\nPackages bundled into build/index.js.\n\n${notices.join("\n")}`);
