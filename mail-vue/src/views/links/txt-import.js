import { normalizeMailboxEmail } from '../mailboxes/batch-mailboxes.js'

export function parseLinkTxtFiles(texts, firstLineIsMailbox = false) {
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw new Error('TXT 内容无效，请重新选择文件')
  if (!firstLineIsMailbox) return { text: texts.join('\n'), mailboxEmail: null }
  if (!texts.length) throw new Error('请选择至少一个 TXT 文件')

  let mailboxEmail = null
  const bodies = texts.map((text, index) => {
    const value = text.replace(/^\uFEFF/, '')
    const separator = /\r\n|\n|\r/.exec(value)
    const header = (separator ? value.slice(0, separator.index) : value).trim()
    const email = normalizeMailboxEmail(header)
    if (!email) throw new Error(`第 ${index + 1} 个 TXT 的首行必须是一个完整主邮箱地址`)
    if (mailboxEmail && mailboxEmail !== email) throw new Error('所选 TXT 的首行主邮箱不一致，请分别导入')
    mailboxEmail = email
    return separator ? value.slice(separator.index + separator[0].length) : ''
  })

  const recipients = new Set()
  for (let index = 0; index < bodies.length; index++) {
    const tokens = bodies[index].split(/[\s,，;；]+/).filter(Boolean)
    for (const token of tokens) {
      const email = normalizeMailboxEmail(token)
      if (!email) throw new Error(`第 ${index + 1} 个 TXT 包含不完整或格式错误的子邮箱地址：${token}`)
      recipients.add(email)
      if (recipients.size > 10000) throw new Error('去重后最多可导入 10000 个子邮箱地址，请拆分文件')
    }
  }
  if (!recipients.size) throw new Error('TXT 首行之后请填写 1～10000 个完整子邮箱地址')
  return { text: bodies.join('\n'), mailboxEmail }
}

function usableMailbox(mailbox, email) {
  if (!mailbox || typeof mailbox.id !== 'string' || !mailbox.id || normalizeMailboxEmail(mailbox.email) !== email) {
    throw new Error('服务器返回的主邮箱信息与 TXT 首行不一致，请刷新后重试')
  }
  if (mailbox.enabled === false) throw new Error(`主邮箱 ${email} 已停用，请先启用后再导入`)
  if (mailbox.enabled !== true) throw new Error('服务器返回的主邮箱状态无效，请刷新后重试')
  return mailbox
}

export async function resolveTxtMailbox(value, request) {
  const email = normalizeMailboxEmail(value)
  if (!email) throw new Error('TXT 首行必须是一个完整主邮箱地址')
  if (typeof request !== 'function') throw new Error('主邮箱请求不可用，请刷新后重试')

  const result = await request('/admin/mailboxes', { query: { email, page: 1, pageSize: 1 } })
  if (!result || !Array.isArray(result.items)) throw new Error('主邮箱查询结果无效，请刷新后重试')
  const matches = result.items.filter(mailbox => normalizeMailboxEmail(mailbox?.email) === email)
  if (matches.length > 1) throw new Error('查询到多个同名主邮箱，请检查主邮箱配置')
  if (matches.length) return { mailbox: usableMailbox(matches[0], email), created: false }

  // The batch endpoint reports existing records too, so a retry after a lost response is safe.
  const created = await request('/admin/mailboxes/batch', { method: 'POST', data: { emails: [email] } })
  const entry = Array.isArray(created?.items) && created.items.length === 1 ? created.items[0] : null
  if (!entry || normalizeMailboxEmail(entry.email) !== email || !['created', 'existing', 'failed'].includes(entry.status)) {
    throw new Error('主邮箱创建结果未确认，请使用原文件重试')
  }
  if (entry.status === 'failed') {
    const error = new Error(entry.error?.message || '主邮箱创建失败，请检查域名和地址占用情况')
    if (entry.error?.code) error.code = entry.error.code
    throw error
  }
  if (typeof entry.mailboxId !== 'string' || !entry.mailboxId) throw new Error('主邮箱创建结果缺少邮箱标识，请使用原文件重试')
  const mailbox = await request(`/admin/mailboxes/${encodeURIComponent(entry.mailboxId)}`)
  return { mailbox: usableMailbox(mailbox, email), created: entry.status === 'created' }
}
