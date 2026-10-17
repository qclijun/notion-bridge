# Vendored files

`protocol.mjs`, `session.mjs` and `transcript.mjs` are upstream code, copied
unmodified from `magpie-notion` 0.2.0. They are the Notion transport: agent-thread
create/send/transcript, browser session discovery, NDJSON decoding. Nothing in them
was edited — that is the point: the fork is confined to `core.mjs` and `tools.mjs`,
so the next upstream release can be diffed in, not merged by hand.

| File | Lines | MD5 | |
| --- | --- | --- | --- |
| `protocol.mjs` | 321 | `deb4ca1a6a275cc4b47cb58a61849f02` | unchanged |
| `session.mjs` | 478 | `6f5e43b063fd900caaed7f4be4aeb170` | unchanged |
| `transcript.mjs` | 128 | `e7f3ef04f4e179fe5885d28486ec6e0b` | unchanged |

`core.mjs` also keeps `ProviderError`, `publicError`, `errorResponse`,
`streamResponse`, `scopedSignal`, `browserSignIn` and `browserReader` byte-for-byte
from upstream; `protocol.mjs` imports `ProviderError` from it, so the file keeps its
name and its shape. `index.mjs` exports the upstream name `NotionPlugin` beside
`NotionBridgePlugin`, which is what lets the upstream test suite run against this
adapter (`scripts/upstream-suite.sh`).

## Provenance

- Upstream checkout: `../magpie-notion` (sibling of this repo) @ `d23d1a9`
  ("Update project name and description in README"), version 0.2.0
- The same bytes are what magpie installed: `@GH@resucdueff-magpie-notion-a99793a@@@1`
  in `~/.cache/magpie/bun/install-cache` (verified with `diff` on every `.mjs` file)
- Upstream: https://github.com/resucdueff/magpie-notion (MIT)

## Re-vendoring after an upstream release

```sh
UP=../magpie-notion              # or a fresh clone
git -C "$UP" pull
cp "$UP"/{protocol,session,transcript}.mjs .
git diff --stat                 # transport: what upstream changed
diff -u <(git show HEAD:core.mjs) "$UP/core.mjs" | head -200   # vs our core
```

Then:

```sh
node --test "test/*.test.mjs"          # our cases, incl. the recorded real stream
scripts/upstream-suite.sh "$UP"        # upstream's 138 transport cases against us
```

and re-check one tool call end to end (`README.md` → Verify), then restart the gateway.
