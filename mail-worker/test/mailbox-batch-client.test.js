import { describe, expect, it, vi } from 'vitest'
import { normalizeEmail } from '../src/modules/mail-sources/matching.js'
import { BATCH_SIZE, MAX_MAILBOXES, normalizeMailboxEmail, parseMailboxInput, generateMailboxEmails,
  createBatchMailboxState, runMailboxBatch, getBatchCounts } from '../../mail-vue/src/views/mailboxes/batch-mailboxes.js'

const created = emails => ({ items: emails.map((email, index) => ({ email, status: 'created', mailboxId: `mailbox-${index}` })) })

describe('batch mailbox address preparation', () => {
  it.each([' USER@EXAMPLE.COM ', 'a+b@example.com', 'a@例子.测试', 'a@127.1', 'a@１２７.１',
    '.a@example.com', 'a..b@example.com', 'a@example.com.', 'a@exa%mple.com', 'a@localhost', 'a@@example.com'])
  ('normalizes addresses consistently with the receiving service: %s', input => {
    expect(normalizeMailboxEmail(input)).toBe(normalizeEmail(input))
  })

  it('rejects path, query and credential characters in imported email domains', () => {
    for (const value of ['a@example.com/path', 'a@example.com?query', 'a@example.com#hash', 'a@example.com:80']) {
      expect(normalizeMailboxEmail(value)).toBeNull()
    }
  })

  it('imports full addresses and prefixes with UTF-8 separators, case-insensitive deduplication and visible errors', () => {
    const parsed = parseMailboxInput('\uFEFFOne\nTWO@EXAMPLE.COM,one@example.com；three，bad..name; a@例子.测试 a@xn--fsqu00a.xn--0zwm56d', '@example.com', { minPrefix: 3 })
    expect(parsed.inputCount).toBe(7)
    expect(parsed.duplicates).toBe(2)
    expect(parsed.items.map(item => item.email)).toEqual(['one@example.com', 'two@example.com', 'three@example.com', 'bad..name@example.com', 'a@xn--fsqu00a.xn--0zwm56d'])
    expect(parsed.items.filter(item => item.error)).toHaveLength(2)
    expect(parseMailboxInput('prefix full@example.com', '').items).toEqual([
      { email: 'prefix', error: '仅填写前缀时，请先选择受控域名' }, { email: 'full@example.com', error: '' },
    ])
  })

  it('bounds raw UTF-8 input and keeps over-limit preview visible for the caller', () => {
    expect(() => parseMailboxInput('中'.repeat(350000), 'example.com')).toThrow('1 MiB')
    expect(parseMailboxInput(Array.from({ length: 1001 }, (_, i) => `mail${i}`).join('\n'), 'example.com').items).toHaveLength(1001)
  })

  it('generates normalized sequential addresses with padding and enforces safe numbering/prefix limits', () => {
    expect(generateMailboxEmails({ mode: 'sequence', domain: '@EXAMPLE.COM', count: 3, prefix: 'TEST', start: 9, padding: 3 }))
      .toEqual(['test009@example.com', 'test010@example.com', 'test011@example.com'])
    expect(() => generateMailboxEmails({ mode: 'sequence', domain: 'example.com', count: 2, start: Number.MAX_SAFE_INTEGER })).toThrow('安全整数')
    expect(() => generateMailboxEmails({ mode: 'sequence', domain: 'example.com', count: 1, prefix: 'x'.repeat(64) })).toThrow('格式')
    expect(() => generateMailboxEmails({ mode: 'sequence', domain: 'example.com', count: 1, prefix: '', padding: 1, minPrefix: 3 })).toThrow('至少需要 3')
  })

  it('generates secure random unique addresses and rejects impossible/invalid ranges', () => {
    const emails = generateMailboxEmails({ domain: 'example.com', count: MAX_MAILBOXES })
    expect(new Set(emails).size).toBe(MAX_MAILBOXES)
    expect(emails.every(email => /^[a-z0-9]{12}@example.com$/.test(email))).toBe(true)
    expect(() => generateMailboxEmails({ domain: 'example.com', count: 37, length: 1 })).toThrow('过短')
    expect(() => generateMailboxEmails({ domain: 'example.com', count: 1, length: 2, minPrefix: 3 })).toThrow('至少需要 3')
    for (const count of [0, 1001, 1.5, NaN, '']) expect(() => generateMailboxEmails({ domain: 'example.com', count })).toThrow('创建数量')
  })

  it('creates a normalized fixed batch, deduplicates and bounds its size', () => {
    expect(createBatchMailboxState(['A@example.com', 'a@EXAMPLE.com']).items).toHaveLength(1)
    expect(() => createBatchMailboxState([])).toThrow('1～1000')
    expect(() => createBatchMailboxState(Array(1001).fill('a@example.com'))).toThrow('1～1000')
    expect(() => createBatchMailboxState(['not-an-email'])).toThrow('格式')
  })
})

describe('batch mailbox request orchestration', () => {
  it('submits bases before plus tags across requests and keeps original result order', async () => {
    const originals = ['base+tag@example.com', ...Array.from({ length: 101 }, (_, i) => `mail${i}@example.com`), 'base@example.com']
    const state = createBatchMailboxState(originals)
    const send = vi.fn(async emails => created(emails))
    await runMailboxBatch(state, send)
    expect(send.mock.calls.map(([emails]) => emails.length)).toEqual([BATCH_SIZE, 3])
    const ordered = send.mock.calls.flatMap(([emails]) => emails)
    expect(ordered.indexOf('base@example.com')).toBeLessThan(ordered.indexOf('base+tag@example.com'))
    expect(state.items.map(item => item.email)).toEqual(originals)
    expect(getBatchCounts(state)).toMatchObject({ total: 103, created: 103, completed: 103, waiting: 0, unknown: 0 })
  })

  it('records mixed outcomes and retries failed items without resubmitting successes', async () => {
    const state = createBatchMailboxState(['new@example.com', 'existing@example.com', 'failed@example.com'])
    const send = vi.fn(async () => ({ items: [
      { email: 'failed@example.com', status: 'failed', error: { code: 'BLOCKED', message: '前缀不可用' } },
      { email: 'existing@example.com', status: 'existing', mailboxId: 'existing-id' },
      { email: 'new@example.com', status: 'created', mailboxId: 'new-id' },
    ] }))
    await runMailboxBatch(state, send)
    expect(getBatchCounts(state)).toMatchObject({ created: 1, existing: 1, failed: 1, completed: 3 })
    expect(state.items[2].error).toEqual({ code: 'BLOCKED', message: '前缀不可用' })
    await runMailboxBatch(state, send)
    expect(send).toHaveBeenCalledTimes(1)
    const retry = vi.fn(async emails => created(emails))
    await runMailboxBatch(state, retry, { retryFailed: true })
    expect(retry).toHaveBeenCalledWith(['failed@example.com'])
    expect(state.items[0]).toMatchObject({ status: 'created', mailboxId: 'new-id' })
    expect(state.items[2]).toMatchObject({ status: 'created', error: null })
  })

  it('pauses after an ambiguous response and retries the same fixed random list while retaining prior successes', async () => {
    const emails = generateMailboxEmails({ domain: 'example.com', count: 230 })
    const state = createBatchMailboxState(emails)
    const send = vi.fn().mockImplementationOnce(async values => created(values)).mockRejectedValueOnce(new Error('断线'))
    await runMailboxBatch(state, send)
    expect(send).toHaveBeenCalledTimes(2)
    expect(state).toMatchObject({ paused: true, running: false })
    expect(getBatchCounts(state)).toMatchObject({ created: 100, unknown: 100, waiting: 30, completed: 100 })
    const retry = vi.fn(async values => ({ items: values.map(email => ({ email, status: 'existing', mailboxId: email })) }))
    await runMailboxBatch(state, retry)
    expect(retry.mock.calls[0][0]).toEqual(emails.slice(100, 200))
    expect(retry.mock.calls[1][0]).toEqual(emails.slice(200))
    expect(state.items.map(item => item.email)).toEqual(emails)
    expect(getBatchCounts(state)).toMatchObject({ created: 100, existing: 130, unknown: 0, completed: 230 })
    expect(state).toMatchObject({ paused: false, error: '' })
  })

  it.each([
    { items: [] },
    { items: [{ email: 'different@example.com', status: 'created', mailboxId: 'other' }] },
    { items: [{ email: 'one@example.com', status: 'unexpected', mailboxId: 'one' }] },
    { items: [{ email: 'one@example.com', status: 'created' }] },
  ])('treats malformed acknowledgement as unknown, preserving safe retry: %j', async response => {
    const state = createBatchMailboxState(['one@example.com'])
    await runMailboxBatch(state, async () => response)
    expect(state.items[0].status).toBe('unknown')
    expect(state.paused).toBe(true)
  })

  it('does not let list refresh failures corrupt confirmed results or trigger retries', async () => {
    const state = createBatchMailboxState(['one@example.com'])
    const send = vi.fn(async emails => created(emails))
    await runMailboxBatch(state, send, { onBatch: async () => { throw new Error('refresh failed') } })
    expect(state.items[0].status).toBe('created')
    expect(state.paused).toBe(false)
    await runMailboxBatch(state, send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('guards concurrent execution and rejects a modified invalid batch', async () => {
    const state = createBatchMailboxState(['one@example.com'])
    state.running = true
    const send = vi.fn()
    await runMailboxBatch(state, send)
    expect(send).not.toHaveBeenCalled()
    state.running = false
    state.items[0].email = 'invalid'
    await expect(runMailboxBatch(state, send)).rejects.toThrow('名单已改变')
    expect(send).not.toHaveBeenCalled()
  })
})
