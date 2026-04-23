# test-typescript-deploys

A minimal TypeScript example that deploys a Python app to
[Tower](https://tower.dev) end-to-end from Node. It uses
[`tower-package-wasm`](https://www.npmjs.com/package/tower-package-wasm) to
build a deterministic tar.gz bundle in memory, and a generated OpenAPI client
(from the Tower API spec) to create the app and upload the bundle.
Authentication is via a Tower API key loaded from `.env`.

## Generating the client

The Tower OpenAPI spec is checked in at `openapi.yaml`. Types for the client
are generated with
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) and
consumed at runtime by
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/). After `npm install`,
run:

```sh
npm run generate
```

This writes `src/generated/api.ts`. Re-run whenever `openapi.yaml` changes. To
refresh the spec itself, pull it from the live service:

```sh
curl -sL https://api.tower.dev/v1/openapi.yaml -o openapi.yaml
```

## Running the app

Copy `.env.example` to `.env` and set `TOWER_API_KEY` (optionally override
`TOWER_APP_NAME`). Then:

```sh
npm install
npm run deploy
```

The script reads `src/sample-app/` (a trivial `main.py` plus a `Towerfile`),
hands the file bytes to `buildPackage` from `tower-package-wasm`, ensures the
named app exists on your account, and POSTs the resulting tarball to
`/apps/{name}/deploy` with an `X-Tower-Checksum-SHA256` header. Deploy runs
through `node --experimental-wasm-modules` because the published
`tower-package-wasm` is the bundler build and imports its `.wasm` file as an ES
module.
