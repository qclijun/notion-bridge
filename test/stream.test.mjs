// End to end on a recorded Notion transcript: transcript frames → events →
// completionChunks. test/fixtures/real-stream.ndjson is upstream's capture of a
// real agent thread (fixtures/real-stream.ndjson in magpie-notion), so this pins
// the adapter to the wire format rather than to hand-made events.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { _internal } from "../core.mjs"
import { readNDJSON, transcriptEvents } from "../transcript.mjs"

const FIXTURE = readFileSync(new URL("./fixtures/real-stream.ndjson", import.meta.url))
const REAL_TEXT = "MAGPIE\\_NOTION\\_OK"

const bash = { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }
const signal = () => new AbortController().signal

// body is the NDJSON frames a transcript read would see: a stream of bytes, the
// way the transport hands them to readNDJSON.
function body(bytes) {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

async function events(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  return transcriptEvents(readNDJSON(body(bytes), signal()), signal())
}

async function collect(chunks) {
  const out = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

function chat(tools) {
  return _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hi" }], ...(tools ? { tools: [bash] } : {}) })
}

test("a real transcript streams through untouched when no tools are offered", async () => {
  const out = await collect(_internal.completionChunks(await events(FIXTURE), "m", signal(), chat(false)))
  assert.equal(out.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), REAL_TEXT)
  assert.equal(out.at(-1).choices[0].finish_reason, "stop")
})

test("the same transcript is buffered, unchanged, when tools are offered", async () => {
  const out = await collect(_internal.completionChunks(await events(FIXTURE), "m", signal(), chat(true)))
  assert.equal(out.some((chunk) => chunk.choices[0].delta.tool_calls), false)
  assert.equal(out.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), REAL_TEXT)
  assert.equal(out.at(-1).choices[0].finish_reason, "stop")
})

test("a transcript whose answer is a tool tag becomes tool_calls", async () => {
  const frames = [
    { type: "agent_service_transcript_delta", patches: [{ op: "put", entity: { id: "a1", kind: "assistant_message", sequence: 1, content: [{ type: "text", text: "let me look " }] } }] },
    { type: "agent_service_transcript_delta", patches: [{ op: "put", entity: { id: "a2", kind: "assistant_message", sequence: 2, content: [{ type: "text", text: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' }] } }] },
    { type: "agent_service_transcript_delta", patches: [{ op: "put", entity: { id: "d1", kind: "turn_completed", sequence: 3, stop_reason: "end_turn" } }] },
  ].map((frame) => JSON.stringify(frame) + "\n").join("")

  const out = await collect(_internal.completionChunks(await events(frames), "m", signal(), chat(true)))
  const calls = out.find((chunk) => chunk.choices[0].delta.tool_calls)
  assert.ok(calls)
  assert.equal(calls.choices[0].delta.tool_calls[0].function.name, "Bash")
  assert.equal(calls.choices[0].delta.tool_calls[0].function.arguments, '{"command":"ls"}')
  assert.equal(out.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), "let me look")
  assert.equal(out.at(-1).choices[0].finish_reason, "tool_calls")
})
