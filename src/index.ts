import { readFile, readdir, stat } from "node:fs/promises";
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

const BASE_URL = "https://api.tower.dev/v1";

const apiKey = process.env.TOWER_API_KEY;
if (!apiKey) {
  console.error("TOWER_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const appName = process.env.TOWER_APP_NAME ?? "test-typescript-deploys";

const client = createClient<paths>({
  baseUrl: BASE_URL,
  headers: { "X-API-Key": apiKey },
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function collectAppFiles(appDir: string): Promise<{
  appFiles: PackageEntry[];
  towerfileBytes: Uint8Array;
}> {
  const files = await walk(appDir);
  const appFiles: PackageEntry[] = [];
  let towerfileBytes: Uint8Array | undefined;

  for (const path of files) {
    const rel = relative(appDir, path).split(sep).join("/");
    const bytes = new Uint8Array(await readFile(path));
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

  if (!towerfileBytes) {
    throw new Error(`No Towerfile found in ${appDir}`);
  }
  return { appFiles, towerfileBytes };
}

async function ensureApp(name: string): Promise<void> {
  const describe = await client.GET("/apps/{name}", {
    params: { path: { name }, query: { runs: 0, timezone: "UTC" } },
  });
  if (describe.response.ok) {
    console.log(`App "${name}" already exists.`);
    return;
  }
  if (describe.response.status !== 404) {
    throw new Error(
      `Unexpected status ${describe.response.status} describing app: ${JSON.stringify(describe.error)}`,
    );
  }

  const created = await client.POST("/apps", {
    body: { name, is_externally_accessible: false },
  });
  if (!created.response.ok) {
    throw new Error(
      `Failed to create app: ${created.response.status} ${JSON.stringify(created.error)}`,
    );
  }
  console.log(`Created app "${name}".`);
}

async function deploy(name: string, pkg: Uint8Array): Promise<void> {
  const checksum = createHash("sha256").update(pkg).digest("hex");

  const result = await client.POST("/apps/{name}/deploy", {
    params: { path: { name } },
    body: pkg as unknown as never,
    bodySerializer: (b) => b as BodyInit,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Tower-Checksum-SHA256": checksum,
      "Content-Length": String(pkg.byteLength),
    },
  });

  if (!result.response.ok) {
    throw new Error(
      `Deploy failed: ${result.response.status} ${JSON.stringify(result.error)}`,
    );
  }

  const version = result.data?.version;
  console.log(`Deployed app "${name}" version ${version?.version ?? "?"}.`);
}

async function main() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const appDir = join(here, "sample-app");
  await stat(appDir);

  const { appFiles, towerfileBytes } = await collectAppFiles(appDir);

  // === tower-package-wasm call site ===
  // Produces the tar.gz byte stream that gets POSTed to /apps/{name}/deploy.
  // Output is byte-deterministic for the same inputs (sorted entries,
  // normalized tar headers, no gzip mtime) — matches the CLI's output.
  const pkg = buildPackage({ appFiles, moduleFiles: [], towerfileBytes });

  console.log(`Built package: ${pkg.byteLength} bytes, ${appFiles.length} app file(s).`);

  await ensureApp(appName);
  await deploy(appName, pkg);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
