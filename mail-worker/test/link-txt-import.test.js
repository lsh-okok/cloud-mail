import { describe, expect, it, vi } from 'vitest'
import { parseLinkTxtFiles, resolveTxtMailbox } from '../../mail-vue/src/views/links/txt-import.js'

describe('child link TXT imports', () => {
  it('keeps unchecked imports completely unchanged, including BOM and original line endings', () => {
    const texts = ['\uFEFFadmin@example.com\r\na1@example.com\r\n', 'not-an-email\ra2@example.com']
    expect(parseLinkTxtFiles(texts)).toEqual({ text: texts.join('\n'), mailboxEmail: null })
    expect(parseLinkTxtFiles([])).toEqual({ text: '', mailboxEmail: null })
  })

  it('strips each file header while preserving body content and CRLF/LF/CR endings for editing', () => {
    const texts = [
      '\uFEFF ADMIN@EXAMPLE.COM \r\n One@example.com, TWO@example.com\r\n',
      'admin@example.com\nthree@example.com；four@example.com\n',
      'Admin@Example.Com\rfive@example.com， six@example.com\r',
    ]
    expect(parseLinkTxtFiles(texts, true)).toEqual({
      mailboxEmail: 'admin@example.com',
      text: ' One@example.com, TWO@example.com\r\n\nthree@example.com；four@example.com\n\nfive@example.com， six@example.com\r',
    })
  })

  it('normalizes the same Unicode/ASCII domains and validates duplicates without rewriting original bodies', () => {
    const texts = ['Admin@例子.测试\na@例子.测试', 'ADMIN@xn--fsqu00a.xn--0zwm56d\nA@xn--fsqu00a.xn--0zwm56d']
    expect(parseLinkTxtFiles(texts, true)).toEqual({ mailboxEmail: 'admin@xn--fsqu00a.xn--0zwm56d',
      text: 'a@例子.测试\nA@xn--fsqu00a.xn--0zwm56d' })
  })

  it.each(['', '\nchild@example.com', 'prefix\nchild@example.com', 'a@example.com b@example.com\nchild@example.com',
    'a@example.com,b@example.com\nchild@example.com', 'bad..name@example.com\nchild@example.com'])
  ('requires exactly one complete mailbox address on the first physical line: %j', text => {
    expect(() => parseLinkTxtFiles([text], true)).toThrow('首行必须是一个完整主邮箱地址')
  })

  it('rejects different mailbox headers before resolving or creating anything', () => {
    expect(() => parseLinkTxtFiles(['a@example.com\nx@example.com', 'b@example.com\ny@example.com'], true)).toThrow('首行主邮箱不一致')
  })

  it.each(['prefix', 'bad..name@example.com', 'a@example.com/path', 'a@@example.com'])
  ('rejects incomplete or malformed child recipients: %s', recipient => {
    expect(() => parseLinkTxtFiles([`admin@example.com\n${recipient}`], true)).toThrow('子邮箱地址')
  })

  it('accepts complete child addresses from domains different from the main mailbox', () => {
    expect(parseLinkTxtFiles(['admin@example.com\na@other.example'], true)).toEqual({
      mailboxEmail: 'admin@example.com', text: 'a@other.example',
    })
  })

  it('imports iCloud forwarding lists without resolving or creating their external child addresses', async () => {
    const texts = [
      '\uFEFFAdmin@Example.com\r\nshop-alias@icloud.com\r\nlogin-alias@icloud.com\r\n',
      'admin@example.com\nother-alias@privaterelay.appleid.com\nSHOP-ALIAS@ICLOUD.COM',
    ]
    const parsed = parseLinkTxtFiles(texts, true)
    expect(parsed).toEqual({ mailboxEmail: 'admin@example.com',
      text: 'shop-alias@icloud.com\r\nlogin-alias@icloud.com\r\n\nother-alias@privaterelay.appleid.com\nSHOP-ALIAS@ICLOUD.COM' })
    const mailbox = { id: 'main-id', email: 'admin@example.com', enabled: true }
    const request = vi.fn(async () => ({ items: [mailbox] }))
    expect(await resolveTxtMailbox(parsed.mailboxEmail, request)).toEqual({ mailbox, created: false })
    expect(request).toHaveBeenCalledExactlyOnceWith('/admin/mailboxes', {
      query: { email: 'admin@example.com', page: 1, pageSize: 1 },
    })
  })

  it('requires at least one child address after the header and rejects invalid file inputs', () => {
    for (const texts of [[], ['admin@example.com'], ['admin@example.com\n \r\n']]) {
      expect(() => parseLinkTxtFiles(texts, true)).toThrow()
    }
    expect(() => parseLinkTxtFiles(['a@example.com', null], true)).toThrow('TXT 内容无效')
  })

  it('counts unique normalized addresses across files and accepts up to 10000', () => {
    const recipients = Array.from({ length: 10000 }, (_, index) => `child${index}@example.com`).join('\n')
    expect(parseLinkTxtFiles([`admin@example.com\n${recipients}`, 'ADMIN@example.com\nCHILD0@EXAMPLE.COM'], true).mailboxEmail).toBe('admin@example.com')
    expect(() => parseLinkTxtFiles([`admin@example.com\n${recipients}\nextra@example.com`], true)).toThrow('最多可导入 10000')
  })
})

describe('TXT main mailbox resolution', () => {
  const mailbox = { id: 'main-id', email: 'admin@example.com', enabled: true, revision: 3, publicId: 'stable-public' }

  it('uses a normalized exact email query and reuses an enabled mailbox without any write', async () => {
    const request = vi.fn(async () => ({ items: [mailbox] }))
    expect(await resolveTxtMailbox(' ADMIN@EXAMPLE.COM ', request)).toEqual({ mailbox, created: false })
    expect(request).toHaveBeenCalledExactlyOnceWith('/admin/mailboxes', { query: { email: 'admin@example.com', page: 1, pageSize: 1 } })
  })

  it('never selects a substring match; creates the requested address and fetches its exact details', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 'wrong', email: 'other-admin@example.com', enabled: true }] })
      .mockResolvedValueOnce({ items: [{ email: 'admin@example.com', status: 'created', mailboxId: 'main/id' }] })
      .mockResolvedValueOnce({ ...mailbox, id: 'main/id' })
    expect(await resolveTxtMailbox(mailbox.email, request)).toEqual({ mailbox: { ...mailbox, id: 'main/id' }, created: true })
    expect(request.mock.calls[1]).toEqual(['/admin/mailboxes/batch', { method: 'POST', data: { emails: ['admin@example.com'] } }])
    expect(request.mock.calls[2]).toEqual(['/admin/mailboxes/main%2Fid'])
  })

  it('handles a concurrent creation or safe retry through the idempotent existing batch result', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ email: mailbox.email, status: 'existing', mailboxId: mailbox.id }] })
      .mockResolvedValueOnce(mailbox)
    expect(await resolveTxtMailbox(mailbox.email, request)).toEqual({ mailbox, created: false })
  })

  it('reports an existing disabled mailbox without issuing a create or enabling it', async () => {
    const request = vi.fn(async () => ({ items: [{ ...mailbox, enabled: false }] }))
    await expect(resolveTxtMailbox(mailbox.email, request)).rejects.toThrow('已停用')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('checks the detail status even when a batch race returns an existing disabled mailbox', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ email: mailbox.email, status: 'existing', mailboxId: mailbox.id }] })
      .mockResolvedValueOnce({ ...mailbox, enabled: false })
    await expect(resolveTxtMailbox(mailbox.email, request)).rejects.toThrow('已停用')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('preserves the specific per-address creation failure and stops before fetching details', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [
      { email: mailbox.email, status: 'failed', error: { code: 'LOCAL_ACCOUNT_UNAVAILABLE', message: '该邮箱已被其他用户占用' } },
    ] })
    await expect(resolveTxtMailbox(mailbox.email, request)).rejects.toMatchObject({ code: 'LOCAL_ACCOUNT_UNAVAILABLE', message: '该邮箱已被其他用户占用' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not create anything after a failed or malformed lookup', async () => {
    const failure = new Error('网络中断')
    const failedRequest = vi.fn().mockRejectedValue(failure)
    await expect(resolveTxtMailbox(mailbox.email, failedRequest)).rejects.toBe(failure)
    expect(failedRequest).toHaveBeenCalledTimes(1)
    const malformed = vi.fn().mockResolvedValue({ items: null })
    await expect(resolveTxtMailbox(mailbox.email, malformed)).rejects.toThrow('查询结果无效')
    expect(malformed).toHaveBeenCalledTimes(1)
  })

  it('requires batch acknowledgement and details to match the requested mailbox', async () => {
    const badResult = vi.fn().mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [
      { email: 'wrong@example.com', status: 'created', mailboxId: 'wrong-id' },
    ] })
    await expect(resolveTxtMailbox(mailbox.email, badResult)).rejects.toThrow('创建结果未确认')
    expect(badResult).toHaveBeenCalledTimes(2)
    const badDetail = vi.fn().mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ email: mailbox.email, status: 'created', mailboxId: mailbox.id }] })
      .mockResolvedValueOnce({ ...mailbox, email: 'wrong@example.com' })
    await expect(resolveTxtMailbox(mailbox.email, badDetail)).rejects.toThrow('与 TXT 首行不一致')
  })

  it('validates the input email before issuing any request', async () => {
    const request = vi.fn()
    await expect(resolveTxtMailbox('not-an-email', request)).rejects.toThrow('完整主邮箱地址')
    expect(request).not.toHaveBeenCalled()
  })
})
