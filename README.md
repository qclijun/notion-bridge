# notion-bridge

Notion AI as a magpie provider **with working tool calls**.

Claude Code, Cowork, Cursor and every other agent that sends a tool set got HTTP 400
from the upstream Notion adapter, which refuses `tools` because Notion's agent-thread
transport cannot carry them. This plugin keeps that transport and bridges the gap in
text: tools are rendered into the prompt as a short protocol, the model answers with
`<tool_call>` tags, and the adapter turns them back into `tool_calls` — which magpie
already renders as the client's own `tool_use` blocks, streaming included.

## Install

```sh
cd ~/Downloads
./magpie-linux-amd64 plugin add /home/jerel/workspace/GitHub/notion-bridge
# then restart the gateway
kill -TERM $(pgrep -f "^\./magpie-linux-amd64")
cd ~/Downloads && setsid env -u ELECTRON_RUN_AS_NODE ./magpie-linux-amd64 > /tmp/magpie.log 2>&1 < /dev/null &
```

`plugin add` with a local path records the path, it does not copy: edits to this repo
are picked up on the next gateway restart. The plugin declares the same provider id
(`notion`) as `opencode-notion-auth`, so the saved sign-in and the desktop's hashed
model aliases keep working — nothing to sign in again, no model names to change.

`plugin list` should say this plugin serves `notion`:

```
/home/jerel/workspace/GitHub/notion-bridge  on
  notion (Notion AI, 29 models)  signed in
```

## Verify

```sh
cd /tmp/nb && python3 probe.py "Read /etc/hostname and tell me what it contains."
# tool_use Read {"file_path": "/etc/hostname"}
# stop_reason: tool_use

python3 stream.py "Use two Bash tool calls: one for whoami, one for uname -r."
# message_start → content_block_start(tool_use) → input_json_delta → content_block_stop
#              → content_block_start(tool_use) → … → message_delta(stop_reason: tool_use)
```

Unit tests: `node --test "test/*.test.mjs"` — 18 cases, no network, including a
recorded real Notion transcript (`test/fixtures/real-stream.ndjson`, upstream's own
capture) run through `transcriptEvents` → `completionChunks`.

Upstream compatibility gate: `scripts/upstream-suite.sh` runs magpie-notion's own 138
transport cases (auth, threads, SSE, cancellation, quota, timeouts) against this
adapter in a scratch package — 134 pass, 2 skipped, 0 fail. The four cases not run are
the two behaviours this adapter deliberately changes (tools and image parts are
accepted now; the upstream npm packaging assertions do not apply), and the script exits
non-zero if their anchors move.

## How it works

| Stage | What happens |
| --- | --- |
| Request | `tools` are compressed to `- name: description` + `{field:type*}` lines and injected as a `[MAGPIE_TOOL_PROTOCOL]` block at the front of the last user message. Older copies of the block are stripped first, so a long conversation carries exactly one. |
| History | `tool_use` blocks and OpenAI `tool_calls` become `<tool_call>{…}</tool_call>`; `tool_result` and `role: "tool"` become `<tool_result>…</tool_result>`. Notion sees one continuous transcript. |
| Response | With tools in play the answer is buffered, `<tool_call>` tags are parsed and name-checked against the request's own tool list, prose around them is kept as a text block, and the result goes back as OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Without tools, nothing is buffered and the answer streams as before. |

`tool_choice: "none"` withholds the protocol entirely; a forced tool (`{type:"function",
function:{name}}`, `"required"`, `"any"`) is named in the protocol as required.

## Why this is a provider plugin and not a gateway middleware

Measured against magpie's own source, both middleware surfaces fall short of the
response half:

- **`.hooks.js` (Bun, async)** — `onRequest` may not change `tools`, `tool_choice`,
  `model` or `stream` (the gateway rejects the whole mutation), and `onResponse` is
  observe-only: its return value is discarded.
- **`.middleware.js` (moejs, synchronous)** — `onRequest` may rewrite the body freely,
  but the reply arrives one SSE event at a time and a replacement can only change that
  event's JSON, not its name and not its count. A tool_use block needs a
  `content_block_start` + `input_json_delta` pair that a text-only stream does not have
  at that point in time. `onResponse` runs only for whole (non-streamed) replies.

At the provider layer both halves are trivial: magpie's gateway does the OpenAI →
Anthropic tool translation itself, in both shapes.

## Known limits

- **Adherence is the model's, not the plugin's.** `notion/albuquerque-quinn` (Opus 5.5)
  follows the protocol reliably — tested with 2 and 8 tools, single and parallel calls,
  prose before a call, and multi-result continuations. `omniberry-sundae` (GPT-6.1 Sol)
  and `amla-jam` (Haiku 5.5) tend to run their own sandbox instead and answer in text.
  Use Opus 5.5 for tool-driven work.
- **A tool-bearing reply is not incremental.** It must be whole before the tags can be
  read, so first byte arrives at the end (≈6–9 s on a warm session). Plain answers still
  stream.
- **Notion native tool calls are impossible.** The transport's `policies` have no switch
  for Notion's own tools, so the protocol is the only channel.
- **The transport files are vendored** (see `VENDOR.md`). Upstream fixes are not picked
  up automatically.

## Rollback

```sh
./magpie-linux-amd64 plugin off /home/jerel/workspace/GitHub/notion-bridge
./magpie-linux-amd64 plugin use github:resucdueff/magpie-notion notion
# restart the gateway
```

The upstream plugin is unpatched: `~/.cache/magpie/bun/install-cache/@GH@resucdueff-magpie-notion-*/core.mjs`
is the original 282-line file, so nothing depends on edits inside magpie's plugin cache.
