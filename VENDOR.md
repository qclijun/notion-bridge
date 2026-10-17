# Vendored files

`protocol.mjs`, `session.mjs` and `transcript.mjs` are upstream code, copied
unmodified from `opencode-notion-auth` 0.2.0 (`github:resucdueff/magpie-notion`).
They are the Notion transport: agent-thread create/send/transcript, browser
session discovery, NDJSON decoding. Nothing in them was edited — that is the point:
the fork is confined to `core.mjs` and `tools.mjs`, so the next upstream release can
be diffed in, not merged by hand.

| File | Lines | MD5 |
| --- | --- | --- |
| `protocol.mjs` | 321 | `deb4ca1a6a275cc4b47cb58a61849f02` |
| `session.mjs` | 478 | `6f5e43b063fd900caaed7f4be4aeb170` |
| `transcript.mjs` | 128 | `e7f3ef04f4e179fe5885d28486ec6e0b` |

`core.mjs` also keeps `ProviderError`, `publicError`, `errorResponse`,
`streamResponse`, `scopedSignal`, `browserSignIn` and `browserReader` byte-for-byte
from upstream; `protocol.mjs` imports `ProviderError` from it, so the file keeps its
name and its shape.

## Re-vendoring after an upstream release

```sh
P=$(ls -d ~/.cache/magpie/bun/install-cache/@GH@resucdueff-magpie-notion-*@@@1 | tail -1)
cp "$P"/{protocol,session,transcript}.mjs .
git diff --stat            # protocol/session/transcript: what upstream changed
git diff core.mjs          # our changes only, review them against the new upstream
diff -u "$P/core.mjs" core.mjs | head -200
```

Then re-run `node --test "test/*.test.mjs"`, restart the gateway, and re-check a tool
call end to end (`README.md` → Verify).

## Source of the copy

- Install cache dir: `@GH@resucdueff-magpie-notion-a99793a@@@1`
- Upstream: https://github.com/resucdueff/magpie-notion (version 0.2.0)
- Both the cache copy and `~/.config/magpie/plugins/node_modules/opencode-notion-auth/`
  are the same inode; the cache copy is pristine (no local patches).
