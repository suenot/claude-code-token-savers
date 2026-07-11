# shuba console

A React single-page app that provides a browser UI for the shuba orchestrator:
chain/health status, delegated-job logs, the graph view, config (secrets
redacted), and token-savings stats.

## Build

```bash
cd orchestrator
bun run console:build   # one-shot build → console/dist/{index.html,main.js}
bun run console:dev     # rebuild on change while developing
```

`console/dist` is **not** committed — build it before `shuba run`/`up` starts
the control sidecar, otherwise the sidecar's `/api/*` endpoints still work but
the SPA routes 404.

## Serve

The console isn't served by a separate dev server — `shuba-control` (the
control sidecar) serves the built `console/dist` directory directly at its
own root. Run `shuba run` (or `shuba up`), then open the URL it prints to
stderr (also shown by `shuba doctor` under the `control:` line), e.g.
`http://127.0.0.1:47830/`. The SPA calls the control server's `/api/*`
endpoints same-origin — no separate proxy or CORS config needed.

## Typecheck

```bash
cd orchestrator && bun run console:typecheck   # tsc --noEmit -p console/tsconfig.json
```
