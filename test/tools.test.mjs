import assert from "node:assert/strict"
import test from "node:test"

import { _internal } from "../core.mjs"
import { compactSchema, contentText, injectProtocol, parseToolCalls, prose, stripProtocol, toolName, toolPreamble } from "../tools.mjs"

const bash = { name: "Bash", description: "Run a shell command\nsecond line", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } }

test("contentText keeps text, renders tool blocks as tags, drops attachments", () => {
  assert.equal(contentText("hi"), "hi")
  assert.equal(
    contentText([
      { type: "text", text: "before" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", content: [{ type: "text", text: "a.txt" }] },
      { type: "image", source: {} },
    ]),
    'before\n<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n<tool_result>a.txt</tool_result>\n[attachment omitted]',
  )
})

test("compactSchema names fields, marks required, keeps optional unions readable", () => {
  assert.equal(compactSchema(bash.input_schema), "{command:string*, timeout:number}  (* = required)")
  assert.equal(compactSchema({ type: "object", properties: { mode: { anyOf: [{ type: "string" }, { type: "null" }] } } }), "{mode:string|null}  (* = required)")
  assert.equal(compactSchema({ type: "object", properties: { level: { enum: ["low", "high"] } } }), "{level:string}  (* = required)")
  assert.equal(compactSchema({}), "{}")
  assert.equal(compactSchema({ type: "object", properties: {} }), "{}")
})

test("toolName reads both definition shapes", () => {
  assert.equal(toolName(bash), "Bash")
  assert.equal(toolName({ type: "function", function: { name: "Read" } }), "Read")
  assert.equal(toolName({ description: "nameless" }), "")
})

test("toolPreamble states the protocol, lists tools once, honours choice", () => {
  const text = toolPreamble([bash], { parallel: false })
  assert.match(text, /^\[MAGPIE_TOOL_PROTOCOL\]/)
  assert.match(text, /NO built-in tools/)
  assert.match(text, /- Bash: Run a shell command\n    \{command:string\*, timeout:number\}/)
  assert.match(text, /exactly one <tool_call> tag/)
  assert.match(text.trimEnd(), /\[\/MAGPIE_TOOL_PROTOCOL\]$/)
  assert.equal(text.match(/- Bash:/g).length, 1)
  assert.match(toolPreamble([bash], { choice: "Read" }), /requires a call to `Read`/)
  assert.match(toolPreamble([bash], { choice: "required" }), /requires a tool call/)
  assert.equal(toolPreamble([]), "")
})

test("injectProtocol removes its own earlier blocks and lands on the last user message", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]
  const preamble = toolPreamble([bash])
  injectProtocol(messages, preamble)
  assert.equal(messages[0].content, "first")
  assert.ok(messages[2].content.startsWith("[MAGPIE_TOOL_PROTOCOL]"))
  assert.ok(messages[2].content.endsWith("\nsecond"))

  injectProtocol(messages, preamble)
  assert.equal(messages[2].content.match(/\[MAGPIE_TOOL_PROTOCOL\]/g).length, 1)
  assert.equal(stripProtocol(messages[2].content), "second")
})

test("parseToolCalls reads tags, fences and bare objects, and filters unknown names", () => {
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>'), [{ name: "Bash", arguments: '{"command":"ls"}' }])

  const two = parseToolCalls('<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n<tool_call>{"name":"Read","arguments":{"file_path":"/a"}}</tool_call>')
  assert.equal(two.length, 2)
  assert.equal(two[1].name, "Read")

  assert.deepEqual(parseToolCalls('<tool_call>{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>'), [{ name: "Bash", arguments: '{"command":"ls"}' }])
  assert.deepEqual(parseToolCalls('```json\n{"name":"Read","arguments":{"file_path":"/a"}}\n```'), [{ name: "Read", arguments: '{"file_path":"/a"}' }])
  assert.deepEqual(parseToolCalls('I will read it: {"name":"Read","arguments":{"file_path":"/a"}} now'), [{ name: "Read", arguments: '{"file_path":"/a"}' }])
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"Bash","arguments":{}}</tool_call>', ["Read"]), [])
  assert.deepEqual(parseToolCalls("plain answer"), [])
  assert.deepEqual(parseToolCalls(""), [])
  // a missing arguments object still yields a valid JSON string, which is what
  // the client parses
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"Bash"}</tool_call>'), [{ name: "Bash", arguments: "{}" }])
})

test("prose keeps what the model said around the call", () => {
  assert.equal(prose('Let me look.\n<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n'), "Let me look.")
  assert.equal(prose('<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>'), "")
})

test("parseChat accepts tools, flattens tool history and injects the protocol", () => {
  const chat = _internal.parseChat({
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "list files" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "1", content: "a.txt" },
    ],
    tools: [bash],
  })
  assert.equal(chat.wantsTools, true)
  assert.deepEqual(chat.toolNames, ["Bash"])
  assert.equal(chat.messages[1].role, "user")
  assert.equal(chat.messages[1].content, "list files")
  assert.equal(chat.messages[2].content, '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>')
  assert.equal(chat.messages[3].role, "user")
  assert.ok(chat.messages[3].content.includes("[MAGPIE_TOOL_PROTOCOL]"))
  assert.ok(chat.messages[3].content.endsWith("<tool_result>a.txt</tool_result>"))
})

test("parseChat without tools leaves the conversation alone", () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hi" }] })
  assert.equal(chat.wantsTools, false)
  assert.equal(chat.messages[0].content, "hi")
})

test("tool_choice none withholds the protocol; a forced tool is named in it", () => {
  const off = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [bash], tool_choice: "none" })
  assert.equal(off.wantsTools, false)
  assert.equal(off.messages[0].content, "hi")

  const forced = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [bash], tool_choice: { type: "function", function: { name: "Bash" } } })
  assert.equal(forced.wantsTools, true)
  assert.match(forced.messages[0].content, /requires a call to `Bash`/)
})

async function* events(list) {
  for (const event of list) yield event
}

async function collect(chunks) {
  const out = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

test("completionChunks streams plain text without tools", async () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hi" }] })
  const chunks = await collect(_internal.completionChunks(events([{ type: "text", text: "he" }, { type: "text", text: "llo" }, { type: "done" }]), "m", new AbortController().signal, chat))
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "hello")
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
})

test("completionChunks turns a tagged answer into one tool_calls chunk with prose kept", async () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "list" }], tools: [bash] })
  const chunks = await collect(_internal.completionChunks(events([
    { type: "text", text: "Sure.\n" },
    { type: "text", text: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' },
    { type: "done" },
  ]), "m", new AbortController().signal, chat))
  const calls = chunks.find((c) => c.choices[0].delta.tool_calls)
  assert.ok(calls, "a tool_calls chunk")
  assert.equal(calls.choices[0].delta.tool_calls[0].function.name, "Bash")
  assert.equal(calls.choices[0].delta.tool_calls[0].function.arguments, '{"command":"ls"}')
  assert.equal(calls.choices[0].delta.tool_calls[0].index, 0)
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "Sure.")
})

test("completionChunks keeps a plain answer plain when tools were offered", async () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "hello" }], tools: [bash] })
  const chunks = await collect(_internal.completionChunks(events([{ type: "text", text: "Hi there." }, { type: "done" }]), "m", new AbortController().signal, chat))
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "Hi there.")
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
})

test("completionChunks drops a truncated call", async () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "list" }], tools: [bash] })
  const chunks = await collect(_internal.completionChunks(events([{ type: "text", text: '<tool_call>{"name":"Bash","argum' }, { type: "done", finishReason: "length" }]), "m", new AbortController().signal, chat))
  assert.equal(chunks.some((c) => c.choices[0].delta.tool_calls), false)
  assert.equal(chunks.at(-1).choices[0].finish_reason, "length")
})

test("bufferedResponse carries tool_calls in the non-streamed shape too", async () => {
  const chat = _internal.parseChat({ model: "m", messages: [{ role: "user", content: "list" }], tools: [bash] })
  const response = await _internal.bufferedResponse(_internal.completionChunks(events([{ type: "text", text: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' }, { type: "done" }]), "m", new AbortController().signal, chat))
  const body = await response.json()
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "Bash")
  assert.equal(body.choices[0].message.content, null)
})
