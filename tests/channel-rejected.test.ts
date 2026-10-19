/**
 * A channel-verification refusal must rotate, not end the request.
 *
 * The reported symptom: "请求被拦截，请重新发送" (WorkBuddy business code 11128,
 * `msg: "request illegal"`). Resending never helped, and the pool card showed
 * every account as healthy.
 *
 * Two independent faults produced that loop, and both are pinned here:
 *
 * 1. `classifyUpstreamError` had no class for the refusal, so a 400/11128 landed
 *    in `client` — the terminal branch. The shim `break`s on `client`, so one
 *    refused account failed the whole request while the other accounts in the
 *    pool were never tried.
 * 2. Even with a rotating class, `acquire` had no reason to skip the refused
 *    account, so every retry of every request came back to it. The pool has to
 *    cool the account, which is what `penalizeChannelRejected` does.
 *
 * The distinction the tests care about most: 11128 is a REUSED code. The gateway
 * also returns it when it dislikes the request shape (the developer-role case
 * documented in `prepareChatBody`), and that one must stay terminal — rotating a
 * malformed request would burn every account on a request no account can serve.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

/** The refusal exactly as the user's log showed it. */
const REFUSED = '{"code":11128,"msg":"request illegal",'
  + '"requestId":"6a8afd83-3840-47c0-b801-c32274d18e29",'
  + '"displayMsg":{"en":"Request blocked. Please send it again","zh":"请求被拦截，请重新发送"},'
  + '"displayTips":{"en":"This call failed channel verification, possibly because it was not sent '
  + 'from an official client. Please resend from the official client.",'
  + '"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"},'
  + '"type":"client","code":"client"}'

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-channel-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

function poolFor(authDir: string): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({
    authDirs: [authDir],
    logger: { warn() {}, info() {}, error() {} },
  })
}

describe('a channel refusal is an account condition, so it rotates', () => {
  /** 400 + 11128 for the refused tokens, a normal SSE stream for everything else. */
  function channelFetch(refusedTokens: readonly string[], hits: string[]) {
    return (async (_url: unknown, init: RequestInit): Promise<Response> => {
      const headers = init.headers as Record<string, string>
      const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
      hits.push(token)
      if (refusedTokens.includes(token)) {
        return new Response(REFUSED, { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  it('serves the request from another account after the first is refused', async () => {
    const pool = poolFor(await fakeAuthDir(2))
    await pool.scan()
    const hits: string[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: channelFetch(['token-0'], hits) })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })

    // The whole point: the user gets an answer instead of "请求被拦截".
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    expect(pool.channelRejectedAccounts()).toHaveLength(1)
    // Exactly one refusal, then the healthy account — not `maxAttempts` refusals
    // from the same account, which is what the user experienced as a dead loop.
    expect(hits.filter(token => token === 'token-0')).toHaveLength(1)
  })

  it('does not hand the refused account back on the next request', async () => {
    // Without the cooldown this is the loop the user hit: `priority` returns the
    // same first account, it refuses again, and no other account is ever tried.
    const pool = poolFor(await fakeAuthDir(2))
    await pool.scan()
    const refused = pool.list()[0]!
    pool.penalizeChannelRejected(refused.id)

    for (let i = 0; i < 5; i += 1) {
      const picked = await pool.acquire('hy4-preview', 'cn')
      expect(picked).toBeDefined()
      expect(picked!.id).not.toBe(refused.id)
    }
  })

  it('answers 400 channel_rejected — not a credential error — when every account is refused', async () => {
    const pool = poolFor(await fakeAuthDir(2))
    await pool.scan()
    const hits: string[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: channelFetch(['token-0', 'token-1'], hits) })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await response.json() as { error?: { code?: string; message?: string } }

    // 400 because that is what the gateway actually said. Reporting 401 would
    // send the user hunting for a credential problem that does not exist.
    expect(response.status).toBe(400)
    expect(body.error?.code).toBe('channel_rejected')
    expect(body.error?.message ?? '').toContain('11128')
    // The message must not tell them to sign in again: the credential is fine.
    expect(body.error?.message ?? '').not.toContain('sign in again')
    expect(hits.filter(token => token === 'token-0')).toHaveLength(1)
    expect(hits.filter(token => token === 'token-1')).toHaveLength(1)
  })

  it('reports channel_rejected rather than a cooldown while the accounts rest', async () => {
    const pool = poolFor(await fakeAuthDir(2))
    await pool.scan()
    for (const account of pool.list()) pool.penalizeChannelRejected(account.id)

    const why = pool.unavailableReason('hy4-preview', 'cn')
    expect(why.reason).toBe('channel_rejected')
    expect(why.channelRejected).toBe(2)
    expect(why.total).toBe(2)
    // Not misreported as waiting on a rate-limit window: waiting for the window
    // is not the remedy, and the two states need opposite messages.
    expect(why.cooling).toBe(0)
    expect(why.dead).toBe(0)
    expect(pool.status().channelRejected).toBe(2)
  })

  it('puts the refused accounts back on the card\'s "clear all cooldowns" button', async () => {
    const pool = poolFor(await fakeAuthDir(1))
    await pool.scan()
    pool.penalizeChannelRejected(pool.list()[0]!.id)
    expect(pool.channelRejectedAccounts()).toHaveLength(1)

    pool.resetCooldowns()
    expect(pool.channelRejectedAccounts()).toHaveLength(0)
    expect(pool.status().channelRejected).toBe(0)
  })
})
