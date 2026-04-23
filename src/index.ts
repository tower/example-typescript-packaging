import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import createClient from "openapi-fetch";
// === tower-package-wasm ===
// `buildPackage` turns in-memory file bytes into the deterministic tar.gz
// bundle format that Tower's deploy endpoint accepts. `PackageEntry` is the
// `{ archiveName, bytes }` shape each file must be supplied in.
import { buildPackage, type PackageEntry } from "tower-package-wasm";
import type { paths } from "./generated/api.js";

// 1. Load configuration and build a typed API client.

const apiKey = process.env.TOWER_API_KEY;
if (!apiKey) {
  console.error("TOWER_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
const name = process.env.TOWER_APP_NAME ?? "test-typescript-deploys";

const client = createClient<paths>({
  baseUrl: "https://api.tower.dev/v1",
  headers: { "X-API-Key": apiKey },
});

function apiError(label: string, res: { response: Response; error?: unknown }): Error {
  return new Error(`${label}: ${res.response.status} ${JSON.stringify(res.error)}`);
}

// 2. Read the sample app off disk.

const appDir = join(fileURLToPath(new URL(".", import.meta.url)), "sample-app");
const appFiles: PackageEntry[] = [];
let towerfileBytes: Uint8Array | undefined;

for (const entry of await readdir(appDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = join(entry.parentPath, entry.name);
  const rel = relative(appDir, full).split(sep).join("/");
  const bytes = new Uint8Array(await readFile(full));
  if (rel === "Towerfile") {
    // tower-package-wasm takes the Towerfile separately: `invoke`,
    // `parameters`, and import paths in the generated MANIFEST are
    // derived from it, so it can't disagree with the embedded copy.
    towerfileBytes = bytes;
  } else {
    // tower-package-wasm requires archive names rooted under `app/` for
    // application files (or `modules/<name>/` for shared modules — not
    // used in this example). The library does no path rewriting.
    appFiles.push({ archiveName: `app/${rel}`, bytes });
  }
}
if (!towerfileBytes) throw new Error(`No Towerfile found in ${appDir}`);

// 3. Build the deterministic tar.gz bundle.

// === tower-package-wasm call site ===
// Produces the tar.gz byte stream that gets POSTed to /apps/{name}/deploy.
// Output is byte-deterministic for the same inputs (sorted entries,
// normalized tar headers, no gzip mtime) — matches the CLI's output.
const pkg = buildPackage({ appFiles, moduleFiles: [], towerfileBytes });
console.log(`Built package: ${pkg.byteLength} bytes, ${appFiles.length} app file(s).`);

// 4. Make sure the app exists on the server. Describe it; create on 404.

const describe = await client.GET("/apps/{name}", {
  params: { path: { name }, query: { runs: 0, timezone: "UTC" } },
});
if (describe.response.ok) {
  console.log(`App "${name}" already exists.`);
} else if (describe.response.status === 404) {
  const created = await client.POST("/apps", {
    body: { name, is_externally_accessible: false },
  });
  if (!created.response.ok) throw apiError("Create app failed", created);
  console.log(`Created app "${name}".`);
} else {
  throw apiError("Describe app failed", describe);
}

// 5. Upload the package.

const checksum = createHash("sha256").update(pkg).digest("hex");
const deployed = await client.POST("/apps/{name}/deploy", {
  params: { path: { name } },
  body: pkg as unknown as never,
  bodySerializer: () => pkg,
  headers: {
    "Content-Type": "application/octet-stream",
    "X-Tower-Checksum-SHA256": checksum,
    "Content-Length": String(pkg.byteLength),
  },
});
if (!deployed.response.ok) throw apiError("Deploy failed", deployed);
console.log(`Deployed app "${name}" version ${deployed.data?.version?.version ?? "?"}.`);

// 6. Run the app and stream its output. The SSE stream closes when the run
// terminates, so reading it to completion doubles as waiting for the run.

const started = await client.POST("/apps/{name}/runs", {
  params: { path: { name } },
  body: { environment: "default", parameters: {} },
});
if (!started.response.ok) throw apiError("Run failed", started);
const seq = started.data!.run.number;
console.log(`Started run #${seq}.`);

const stream = await client.GET("/apps/{name}/runs/{seq}/logs/stream", {
  params: { path: { name, seq } },
  parseAs: "stream",
});
if (!stream.response.ok) throw apiError("Log stream failed", stream);

for (const frame of (await stream.response.text()).split("\n\n")) {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  if (event !== "log" || !data) continue;
  const log = JSON.parse(data);
  if (log.channel === "program") console.log(`  ${log.content}`);
}
console.log(`Run #${seq} complete.`);
