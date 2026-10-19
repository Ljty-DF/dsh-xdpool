/**
 * The client-identity headers on chat completions.
 *
 * These exist for two reasons.
 *
 * The first is billing attribution: the gateway attributes every
 * `/v2/chat/completions` to a client, and that attribution is what the user
 * sees in their billing console as the "使用端" column. The desktop app sends
 * `X-IDE-Type`/`X-IDE-Name`/`X-IDE-Version` and reads as "WorkBuddy"; without
 * them our requests attributed to nothing and the column showed "–" — which
 * read as broken billing even though every credit was deducted correctly.
 *
 * The second is admission: since 2026-10-15/16 the international gateway checks
 * a per-account channel gate that expects the conversation-identity headers the
 * desktop client sends (`X-Conversation-ID`, `X-Conversation-Request-ID`,
 * `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent`,
 * `X-Agent-Purpose`, `x-codebuddy-request`, `X-Private-Data`). Without them the
 * account is refused with business code 11128 and the user sees
 * "请求被拦截，请重新发送" — and resending never helped, because nothing about
 * the request had changed.
 *
 * The regression this guards against is subtle, which is why the assertions are
 * on the exact header set rather than "some headers exist": the temptation when
 * refactoring is to fold these into the shared `chatHeaders()`, which would put
 * identity headers on the points-automation endpoints too — endpoints the
 * desktop app has never been shown to send them on. Both directions are wrong,
 * so both are pinned.
 */
import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient, type WorkBuddyCredential } from '../src/upstream.ts'

/** A minimal credential; the headers under test do not depend on its details. */
function credential(): WorkBuddyCredential {
  return {
    accessToken: 'tok',
    refreshToken: 'ref',
    uid: 'u1',
    enterpriseId: 'e1',
    domain: 'd1',
  } as unknown as WorkBuddyCredential
}

/** A recording fetch that answers a chat with SSE and anything else with JSON. */
function recordingFetch() {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const impl = async (url: unknown, init: RequestInit): Promise<Response> => {
    const target = String(url)
    seen.push({ url: target, headers: init.headers as Record<string, string> })
    // Chat completions stream; every other endpoint answers a JSON envelope.
    const isChat = target.includes('/v2/chat/completions')
    return new Response(isChat ? 'data: [DONE]\n\n' : '{"code":0,"data":[]}\n', {
      status: 200,
      headers: { 'Content-Type': isChat ? 'text/event-stream' : 'application/json' },
    })
  }
  return { seen, options: { fetchImpl: impl as unknown as typeof fetch } }
}

/** Every path in the client that POSTs a chat completion. */
function chatPaths(): {
  name: string
  run: (client: WorkBuddyUpstreamClient, key?: string) => Promise<unknown>
}[] {
  return [
    { name: 'completeChat', run: (c, key) => c.completeChat(credential(), '{}', undefined, key) },
    { name: 'chatStream', run: (c, key) => c.chatStream(credential(), '{}', undefined, key) },
  ]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('chat completions carry the desktop client identity', () => {
  for (const path of chatPaths()) {
    it(`${path.name} sends the three X-IDE headers`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client)
      expect(seen).toHaveLength(1)
      expect(seen[0].url).toContain('/v2/chat/completions')
      expect(seen[0].headers['X-IDE-Type']).toBe('WorkBuddy')
      expect(seen[0].headers['X-IDE-Name']).toBe('WorkBuddy')
      expect(seen[0].headers['X-IDE-Version']).toBe('5.5.6')
    })

    it(`${path.name} keeps the shared auth and product headers alongside them`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client)
      // The identity headers must not have REPLACED the auth contract.
      expect(seen[0].headers['Authorization']).toBe('Bearer tok')
      expect(seen[0].headers['X-Product']).toBe('SaaS')
      expect(seen[0].headers['X-User-Id']).toBe('u1')
    })
  }
})

describe('chat completions carry the conversation identity the gateway verifies', () => {
  /**
   * The gateway's per-account channel check (business code 11128) looks for the
   * conversation-identity headers the desktop client sends. Without them an
   * account is refused with "请求被拦截，请重新发送", and resending never helped
   * because the refusal is about the headers, not about the request.
   */
  for (const path of chatPaths()) {
    it(`${path.name} sends the conversation headers`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client, 'conversation-1')
      const headers = seen[0].headers
      expect(headers['X-Agent-Intent']).toBe('craft')
      expect(headers['X-Agent-Purpose']).toBe('conversation')
      expect(headers['x-codebuddy-request']).toBe('1')
      expect(headers['X-Private-Data']).toBe('true')
      // The three ids the desktop app mints once per conversation, plus the two
      // it mints per request. All five are UUID-shaped; the gateway has been
      // observed to care about the shape, not just the presence.
      expect(headers['X-Conversation-ID']).toMatch(/^wb2auto-conv-[0-9a-f]{24}$/)
      expect(headers['X-Conversation-Request-ID']).toMatch(UUID)
      expect(headers['acp-connection-id']).toMatch(UUID)
      expect(headers['X-Conversation-Message-ID']).toMatch(UUID)
      expect(headers['X-Request-ID']).toMatch(UUID)
    })
  }

  it('keeps the conversation ids stable and the per-request ids fresh', async () => {
    // Stability is the whole point: the desktop app derives these once per
    // conversation, so a new value on every request would look like a new
    // conversation each time — which is the state the gateway refused.
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    await client.chatStream(credential(), '{}', undefined, 'conversation-1')
    await client.chatStream(credential(), '{}', undefined, 'conversation-1')
    expect(seen).toHaveLength(2)
    expect(seen[1].headers['X-Conversation-ID']).toBe(seen[0].headers['X-Conversation-ID'])
    expect(seen[1].headers['X-Conversation-Request-ID']).toBe(seen[0].headers['X-Conversation-Request-ID'])
    expect(seen[1].headers['acp-connection-id']).toBe(seen[0].headers['acp-connection-id'])
    // These two are per REQUEST in the desktop app, so they must not repeat.
    expect(seen[1].headers['X-Request-ID']).not.toBe(seen[0].headers['X-Request-ID'])
    expect(seen[1].headers['X-Conversation-Message-ID']).not.toBe(seen[0].headers['X-Conversation-Message-ID'])
  })

  it('gives a different conversation its own ids', async () => {
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    await client.chatStream(credential(), '{}', undefined, 'conversation-1')
    await client.chatStream(credential(), '{}', undefined, 'conversation-2')
    expect(seen[1].headers['X-Conversation-ID']).not.toBe(seen[0].headers['X-Conversation-ID'])
    expect(seen[1].headers['X-Conversation-Request-ID']).not.toBe(seen[0].headers['X-Conversation-Request-ID'])
  })

  it('still sends valid ids when the caller has no conversation key', async () => {
    // A caller that cannot name its conversation must not send a malformed
    // header: a bad shape is worse than a fresh id.
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    await client.chatStream(credential(), '{}')
    expect(seen[0].headers['X-Conversation-ID']).toMatch(/^wb2auto-conv-[0-9a-f]{24}$/)
    expect(seen[0].headers['X-Request-ID']).toMatch(UUID)
  })
})

describe('non-chat endpoints stay free of identity headers', () => {
  it('the points-automation task list does not claim to be the desktop app', async () => {
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    await client.listTasks(credential())
    expect(seen).toHaveLength(1)
    expect(seen[0].url).not.toContain('/v2/chat/completions')
    expect(seen[0].headers['X-IDE-Type']).toBeUndefined()
    expect(seen[0].headers['X-IDE-Name']).toBeUndefined()
    // The conversation headers are equally chat-only: the points-automation
    // endpoints have never been shown to want them, and claiming a conversation
    // on a task-list call would be a new claim about our traffic.
    expect(seen[0].headers['X-Conversation-ID']).toBeUndefined()
    expect(seen[0].headers['X-Agent-Purpose']).toBeUndefined()
    expect(seen[0].headers['X-Request-ID']).toBeUndefined()
  })

  it('openConversation keeps sending its own identity headers', async () => {
    // The automation's conversation opener predates this fix and already sent
    // the three headers inline. It now shares the same constant, so pinning it
    // here catches one path drifting from the other.
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    const opened = await client.openConversation(credential())
    // openConversation tolerates a stream that ends immediately.
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(opened === undefined || typeof opened === 'object').toBe(true)
  })
})
