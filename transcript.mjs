import { ProviderError } from "./core.mjs"

function invalid() {
  return new ProviderError(502, "invalid_transcript", "Notion AI returned an unsupported transcript update.")
}

function messageText(entity) {
  if (!Array.isArray(entity.content)) throw invalid()
  return entity.content.filter((part) => part?.type === "text").map((part) => {
    if (typeof part.text !== "string") throw invalid()
    return part.text
  }).join("")
}

function append(entity, operation) {
  if (operation.op !== "append" || typeof operation.value !== "string") throw invalid()
  const match = /^\/content\/(\d+)\/text$/.exec(operation.path)
  if (!match) throw invalid()
  const part = entity.content?.[Number(match[1])]
  if (part?.type !== "text" || typeof part.text !== "string") throw invalid()
  part.text += operation.value
}

export function sessionError(session) {
  const allowance = session?.last_turn_allowance
  if (allowance?.notion_exhausted === true) throw new ProviderError(402, "credits_exhausted", "The Notion workspace has exhausted its Notion AI credits.")
  if (allowance?.chatgpt_exhausted === true) throw new ProviderError(402, "connected_plan_exhausted", "The connected ChatGPT plan's allowance is exhausted.")
  if (session?.pending_input) throw new ProviderError(409, "notion_action_required", "The Notion agent requires approval or input in the Notion client.")
}

export async function* readNDJSON(body, signal) {
  if (!body) throw invalid()
  const reader = body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      if (pending.length > 4 * 1024 * 1024) throw new ProviderError(502, "transcript_frame_too_large", "Notion AI returned an oversized transcript frame.")
      let newline
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (!line) continue
        try { yield JSON.parse(line) } catch (error) {
          if (error instanceof SyntaxError) throw invalid()
          throw error
        }
      }
    }
    pending += decoder.decode()
    if (pending.trim()) {
      let value
      try { value = JSON.parse(pending) } catch { throw invalid() }
      yield value
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Real Notion transcript deltas replace provisional messages with committed
// entities. Apply the whole patch batch before comparing the visible text.
export async function* transcriptEvents(frames, signal, { afterSequence = 0 } = {}) {
  const entities = new Map()
  let emitted = ""
  for await (const frame of frames) {
    signal?.throwIfAborted()
    if (!["agent_service_transcript_delta", "agent_service_transcript_page"].includes(frame?.type)) continue
    if (!Array.isArray(frame.patches)) throw invalid()
    const checkSession = (session) => {
      if (afterSequence === 0 || session?.sequence > afterSequence || session?.last_turn_allowance?.sequence > afterSequence) sessionError(session)
    }
    checkSession(frame.session)
    let completed
    for (const patch of frame.patches) {
      if (patch.op === "put") {
        const entity = patch.entity
        if (!entity || typeof entity.id !== "string") throw invalid()
        if (entity.kind === "turn_completed" && (!Number.isSafeInteger(entity.sequence) || entity.sequence <= 0 || (entity.source !== undefined && entity.source !== "committed"))) throw invalid()
        if (entity.sequence <= afterSequence) continue
        entities.set(entity.id, structuredClone(entity))
        if (entity.kind === "error") throw new ProviderError(502, "notion_agent_error", "The Notion agent reported an error. Open its thread in Notion for details.")
        if (entity.kind === "client_update_required") throw new ProviderError(502, "notion_client_update_required", "Notion requires a newer client protocol.")
        if (entity.kind === "status" && entity.status === "per_user_connection_required") throw new ProviderError(409, "connection_required", "Complete the requested account connection in the Notion client.")
        if (entity.kind === "turn_completed") completed = entity
      } else if (patch.op === "remove") {
        entities.delete(patch.id)
      } else if (patch.op === "patch") {
        const entity = entities.get(patch.id)
        if (entity?.kind !== "assistant_message") continue
        if (!Array.isArray(patch.ops)) throw invalid()
        for (const operation of patch.ops) append(entity, operation)
      } else if (["session_status", "session"].includes(patch.op)) checkSession(patch.session)
      else if (patch.op !== "committed") throw invalid()
    }
    const visible = [...entities.values()].filter((entity) => entity.kind === "assistant_message").sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map(messageText).join("")
    if (visible.startsWith(emitted)) {
      const delta = visible.slice(emitted.length)
      emitted = visible
      if (delta) yield { type: "text", text: delta }
    } else if (!emitted.startsWith(visible)) {
      throw new ProviderError(502, "transcript_rewritten", "Notion AI rewrote text already sent to the client.")
    }
    if (completed) {
      if (completed.stop_reason === "requires_action") throw new ProviderError(409, "notion_action_required", "The Notion agent requires approval or input in the Notion client.")
      if (["runtime_error", "retries_exhausted"].includes(completed.stop_reason)) throw new ProviderError(502, "notion_agent_error", "The Notion agent could not complete this turn.")
      if (completed.stop_reason !== "end_turn") {
        throw new ProviderError(502, "unsupported_stop_reason", "Notion AI ended with an unverified stop reason.")
      }
      if (!visible.startsWith(emitted)) throw invalid()
      yield { type: "done", finishReason: "stop", sequence: completed.sequence }
      return
    }
  }
  throw new ProviderError(502, "incomplete_upstream", "Notion AI ended the transcript before turn completion.")
}

export const _internal = { append, messageText, sessionError }
