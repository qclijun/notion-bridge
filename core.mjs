// notion-bridge: Notion AI as a magpie provider that can call tools.
//
// The upstream adapter (opencode-notion-auth) speaks Notion's agent-thread
// protocol, which carries one assistant text per turn and refuses any request
// that declares tools. Every client that works in tool calls — Claude Code,
// Cowork, Cursor, anything that sends a tool set — got HTTP 400, and nothing
// upstream could be changed without patching a file in magpie's content
// addressed plugin cache, which every plugin upgrade overwrote.
//
// This adapter is ours. It keeps the transport exactly as it was (protocol.mjs,
// session.mjs and transcript.mjs are vendored verbatim, see VENDOR.md) and
// replaces only the request and response shaping:
//
//   request   tools rendered as a text protocol (tools.mjs), tool history
//             flattened back into that protocol's tags
//   response  the tags parsed into OpenAI tool_calls, which magpie translates
//             into the client's own tool_use blocks — streaming included
//
// The response side is why this is a provider rather than a gateway middleware:
// magpie's synchronous middleware can rewrite one stream event at a time (data
// only, same event name), so it cannot turn a text delta into the
// content_block_start / input_json_delta sequence a tool_use block needs, and
// its onResponse only runs for whole replies. tool_calls at this layer cost
// nothing: the gateway already renders them in both shapes.

import { randomUUID } from "node:crypto"
import * as localSession from "./session.mjs"
import { contentText, injectProtocol, parseToolCalls, prose, tagFor, toolName, toolPreamble } from "./tools.mjs"

const ID = "notion"
const VIRTUAL_API = "https://notion.invalid/v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()

export class ProviderError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
    if (status === 401) this.signIn = "expired"
  }
}

function publicError(error) {
  if (error instanceof ProviderError) return { message: error.message, type: "notion_error", code: error.code }
  return { message: "Notion AI request failed. No upstream diagnostic or session data was included.", type: "notion_error", code: "upstream_error" }
}

function errorResponse(error) {
  return Response.json({ error: publicError(error) }, {
    status: error instanceof ProviderError ? error.status : 502,
    ...(error?.signIn === "expired" ? { headers: { "X-Magpie-Sign-In": "expired" } } : {}),
  })
}

// forcedChoice reads tool_choice in either shape: a name, "required"/"any", or
// undefined for no constraint. "none" is handled before the tools are offered.
function forcedChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return undefined
  if (toolChoice === "none") return "none"
  if (toolChoice === "required" || toolChoice === "any") return "required"
  const name = toolChoice?.name ?? toolChoice?.function?.name
  if (typeof name === "string" && name) return name
  if (toolChoice?.type === "any") return "required"
  return undefined
}

function parseChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProviderError(400, "invalid_request", "Expected a JSON chat request.")
  if (typeof body.model !== "string" || !body.model.trim()) throw new ProviderError(400, "invalid_model", "A verified workspace model id is required.")
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new ProviderError(400, "invalid_stream", "stream must be a boolean.")
  if (body.n !== undefined && body.n !== 1) throw new ProviderError(400, "unsupported_parameter", "Only one completion is supported.")
  if (!Array.isArray(body.messages) || !body.messages.length) throw new ProviderError(400, "invalid_messages", "At least one message is required.")
  const offered = Array.isArray(body.tools) ? body.tools.filter((tool) => toolName(tool)) : []
  const choice = forcedChoice(body.tool_choice)
  const tools = choice === "none" ? [] : offered
  const messages = []
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue
    let role = message.role
    const result = role === "tool" || role === "function"
    if (result) role = "user"
    if (!["system", "developer", "user", "assistant"].includes(role)) {
      throw new ProviderError(400, "unsupported_message", "Only text system, developer, user and assistant messages are supported.")
    }
    let content = contentText(message.content)
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const tags = message.tool_calls
        .map((call) => tagFor(call?.function?.name ?? call?.name ?? "", call?.function?.arguments ?? call?.arguments ?? {}))
        .join("\n")
      content = content ? content + "\n" + tags : tags
    }
    if (result) content = "<tool_result>" + content + "</tool_result>"
    if (!content) content = "(empty)"
    messages.push({ role, content })
  }
  if (tools.length) injectProtocol(messages, toolPreamble(tools, { choice, parallel: body.parallel_tool_calls !== false }))
  const { functions, tool_choice, function_call, parallel_tool_calls, ...rest } = body
  return { ...rest, messages, tools, toolNames: tools.map(toolName), wantsTools: tools.length > 0 }
}

// These events are an adapter contract, not a claim about Notion's wire format.
// A decoder must yield text deltas and one explicit done; EOF alone is a failure.
async function* completionChunks(events, model, signal, chat) {
  const id = "chatcmpl-" + randomUUID()
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish_reason = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })
  const wantsTools = chat?.wantsTools === true
  yield chunk({ role: "assistant", content: "" })
  let buffered = ""
  let finish = "stop"
  try {
    for await (const event of events) {
      signal.throwIfAborted()
      if (event?.type === "text" && typeof event.text === "string") {
        if (!event.text) continue
        // A reply that may be a tool call has to be whole before it can be
        // read, so the stream degrades to one answer. Plain answers stream.
        if (wantsTools) buffered += event.text
        else yield chunk({ content: event.text })
      } else if (event?.type === "done" && ["stop", "length", "content_filter"].includes(event.finishReason ?? "stop")) {
        finish = event.finishReason ?? "stop"
        break
      } else {
        throw new ProviderError(502, "invalid_upstream_event", "Notion AI returned an unsupported response event.")
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  }
  if (!wantsTools) {
    yield chunk({}, finish)
    return
  }
  const calls = finish === "length" ? [] : parseToolCalls(buffered, chat.toolNames)
  if (calls.length) {
    const said = prose(buffered)
    if (said) yield chunk({ content: said })
    yield chunk({ tool_calls: calls.map((call, index) => ({ index, id: "call_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "function", function: { name: call.name, arguments: call.arguments } })) })
    yield chunk({}, "tool_calls")
    return
  }
  if (buffered) yield chunk({ content: buffered })
  yield chunk({}, finish)
}

function streamResponse(chunks, cancel) {
  const iterator = chunks[Symbol.asyncIterator]()
  const frame = (value) => encoder.encode("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n")
  let ended = false
  return new Response(new ReadableStream({
    async pull(controller) {
      if (ended) return
      try {
        const next = await iterator.next()
        if (ended) return
        if (next.done) {
          ended = true
          controller.enqueue(frame("[DONE]"))
          controller.close()
          cancel()
        } else controller.enqueue(frame(next.value))
      } catch (error) {
        if (ended) return
        ended = true
        controller.enqueue(frame({ error: publicError(error) }))
        controller.close()
        cancel()
      }
    },
    async cancel(reason) {
      ended = true
      cancel(reason)
      await iterator.return?.()
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } })
}

async function bufferedResponse(chunks) {
  let result
  let content = ""
  let finishReason
  let toolCalls
  for await (const chunk of chunks) {
    result ??= chunk
    const delta = chunk.choices[0].delta
    if (Array.isArray(delta.tool_calls)) toolCalls = delta.tool_calls
    content += delta.content ?? ""
    finishReason = chunk.choices[0].finish_reason ?? finishReason
  }
  const message = toolCalls ? { role: "assistant", content: content ? content : null, tool_calls: toolCalls } : { role: "assistant", content }
  return Response.json({ id: result.id, object: "chat.completion", created: result.created, model: result.model, choices: [{ index: 0, message, finish_reason: finishReason }] })
}

function scopedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(new ProviderError(499, "request_cancelled", "The client cancelled the Notion AI request."))
  const timer = setTimeout(() => controller.abort(new ProviderError(504, "request_timeout", "The Notion AI request exceeded its total time limit.")), timeoutMs)
  timer.unref?.()
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  return { signal: controller.signal, close: (reason) => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.abort(reason)
  } }
}

// browserSignIn takes the Notion session of the browser this machine is already
// signed in to, the way the other magpie plugins take the sign-in of the app
// they belong to. Nothing is asked and nothing is shown: the method resolves on
// its own, and the workspace is discovered from the session later, so nobody
// has to paste a UUID.
async function browserSignIn(session) {
  return {
    url: "",
    instructions: "Reads the Notion session from the Chrome, Edge, Brave, Chromium or Firefox profile on this machine.",
    method: "auto",
    callback: async () => {
      try {
        const found = await session.findSession()
        return {
          type: "success",
          key: found.cookie,
          metadata: { browser: found.browser, profile: found.profile, ...(found.via ? { via: found.via } : {}), ...(found.activeUserId ? { activeUserId: found.activeUserId } : {}) },
        }
      } catch (error) {
        return { type: "failed", error: error instanceof Error ? error.message : "The Notion session in this machine's browser could not be read." }
      }
    },
  }
}

// browserReader is the sign-in a request runs with: a session taken from a
// browser is read again, since the browser may have signed in again since it was
// kept. A read that fails keeps the session that was saved rather than failing
// the request, and the workspace is rediscovered from the session itself.
//
// Reading a browser is not free - a store is copied and opened, or a running
// browser is asked over its debugging port, which can take seconds on a busy
// machine - so an answer is reused for a while instead of on every request, and
// a request that came back unauthorized drops it at once: a sign-in that has
// been renewed in the browser is then picked up on the very next request.
export function browserReader(session, windowMs) {
  let last
  return {
    async read(auth) {
      if (typeof auth?.metadata?.browser !== "string") return auth
      if (last && Date.now() - last.at < windowMs) return last.auth
      try {
        const found = await session.findSession()
        last = {
          at: Date.now(),
          auth: {
            ...auth,
            key: found.cookie,
            metadata: { ...auth.metadata, browser: found.browser, profile: found.profile, ...(found.via ? { via: found.via } : {}), ...(found.activeUserId ? { activeUserId: found.activeUserId } : {}) },
          },
        }
        return last.auth
      } catch {
        return auth
      }
    },
    forget() {
      last = undefined
    },
  }
}

export function createPlugin(protocol, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000
  const browserReadMs = options.browserReadMs ?? 60_000
  const session = options.session ?? localSession
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error("Notion timeoutMs must be between 1000 and 3600000 milliseconds.")
  if (!Number.isSafeInteger(browserReadMs) || browserReadMs < 0) throw new Error("Notion browserReadMs must be zero or more whole milliseconds.")
  const reader = browserReader(session, browserReadMs)
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: "Notion AI",
        npm: "@ai-sdk/openai-compatible",
        api: VIRTUAL_API,
        models: { "omniberry-sundae": { name: "GPT-6.1 Sol", tool_call: true, attachment: false, modalities: { input: ["text"], output: ["text"] } } },
      }
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [
        { type: "oauth", label: "Use the Notion session in this browser", authorize: () => browserSignIn(session) },
        {
          type: "api",
          label: "Notion web session (paste the Cookie header)",
          prompts: [
            { type: "text", key: "spaceId", message: "Notion workspace id (optional UUID; blank finds it from the session)", placeholder: "(blank)", validate: (value) => !value || UUID.test(value) ? undefined : "Enter the workspace's UUID, or leave blank to find it from the session." },
            { type: "text", key: "activeUserId", message: "Notion active user UUID (optional; blank for the session default)", placeholder: "(blank)", validate: (value) => !value || UUID.test(value) ? undefined : "Enter a user UUID or leave blank." },
          ],
        },
      ],
      async loader(getAuth) {
        return {
          baseURL: VIRTUAL_API,
          apiKey: "notion-local-adapter",
          async fetch(input, init = {}) {
            let scope
            try {
              const request = new Request(input, init)
              const url = new URL(request.url)
              if (url.origin !== new URL(VIRTUAL_API).origin || url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
                throw new ProviderError(400, "unsupported_request", "Only chat completions are supported by this adapter.")
              }
              let body
              try { body = await request.json() } catch { throw new ProviderError(400, "invalid_json", "Expected a JSON chat request.") }
              const chat = parseChat(body)
              scope = scopedSignal(request.signal, timeoutMs)
              scope.signal.throwIfAborted()
              const auth = await reader.read(await getAuth())
              const events = await protocol.open({ auth, chat, signal: scope.signal })
              const chunks = completionChunks(events, chat.model, scope.signal, chat)
              if (chat.stream) return streamResponse(chunks, scope.close)
              try { return await bufferedResponse(chunks) } finally { scope.close() }
            } catch (error) {
              if (scope?.signal.aborted && scope.signal.reason instanceof ProviderError) error = scope.signal.reason
              scope?.close()
              if (error?.status === 401) reader.forget()
              return errorResponse(error)
            }
          },
        }
      },
      // Magpie's usage card: the workspace's rolling and billing allowance
      // plus the premium credit balance. A missing auth or an unreadable
      // response is an error to show, never an empty account.
      async usage(getAuth) {
        try {
          return await protocol.usage({ auth: await reader.read(await getAuth()) })
        } catch {
          return { error: "The Notion AI quota could not be read.", windows: [] }
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth }) {
        const models = await protocol.models({ provider, auth })
        // The transport carries tools as text now, so what the catalog serves
        // can be offered as a tool-calling model; the protocol's adherence
        // still depends on the model itself (see README).
        for (const model of Object.values(models ?? {})) {
          if (model?.capabilities) model.capabilities.toolcall = true
        }
        return models
      },
    },
  }
}

export const _internal = { parseChat, completionChunks, streamResponse, bufferedResponse, publicError, scopedSignal, errorResponse, browserReader, forcedChoice }
