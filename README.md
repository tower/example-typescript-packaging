# example-typescript-packaging

A minimal TypeScript example that packages a Python app, deploys it to
[Tower](https://tower.dev), runs it, and streams the output back to your
terminal. Uses
[`tower-package-wasm`](https://www.npmjs.com/package/tower-package-wasm)
for packaging and a generated OpenAPI client
([`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) +
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript))
for the API calls.

## Generating the client

The Tower OpenAPI spec is checked in at `openapi.yaml`. After `npm install`:

```sh
npm run generate
```

This writes `src/generated/api.ts`. Re-run whenever `openapi.yaml` changes.
To refresh the spec itself, pull it from the live service:

```sh
curl -sL https://api.tower.dev/v1/openapi.yaml -o openapi.yaml
```

## Running the example

Copy `.env.example` to `.env` and set `TOWER_API_KEY` (optionally override
`TOWER_APP_NAME`). Then:

```sh
npm install
npm run deploy-and-run
```

Expected output:

```
Created app "test-typescript-deploys".
Built package: 360 bytes, 1 app file(s).
Deployed app "test-typescript-deploys" version v1.
Started run #1.
  hello from test-typescript-deploys
Run #1 complete.
```

`src/index.ts` reads as six numbered steps: load config, ensure the app
exists, [read the files, build the bundle with `tower-package-wasm`, and
upload them to the deploy endpoint](src/index.ts#L49-L97), then run the
app and stream its output.

`deploy-and-run` invokes `node --experimental-wasm-modules` because the
published `tower-package-wasm` is the bundler build and imports `.wasm`
as an ES module.
