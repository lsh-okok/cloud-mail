export const MAX_MAILBOXES = 1000
export const BATCH_SIZE = 100
const MAX_INPUT_BYTES = 1024 * 1024
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

function normalizeDomain(value) {
  if (typeof value !== 'string') return null
  const domain = value.trim().toLowerCase().replace(/^@/, '')
  if (!domain || /[\s/#:?@\[\]\\%]/.test(domain)) return null
  let normalized
  try {
    // URL uses the same IDNA conversion as the receiving service's domainToASCII.
    normalized = new URL(`http://${domain}`).hostname
  } catch { return null }
  if (normalized.length > 253 || !normalized.includes('.') || !normalized.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
  return normalized
}

export function normalizeMailboxEmail(value) {
  if (typeof value !== 'string') return null
  const parts = value.trim().toLowerCase().split('@')
  if (parts.length !== 2) return null
  const local = parts[0]
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local) ||
    local.includes('..') || local.startsWith('.') || local.endsWith('.')) return null
  const domain = normalizeDomain(parts[1])
  if (!domain) return null
  const email = `${local}@${domain}`
  return email.length <= 254 ? email : null
}

function minimumPrefix(value) {
  const min = Number(value)
  if (!Number.isSafeInteger(min) || min < 0) throw new Error('邮箱最短前缀设置无效，请重新加载域名')
  return Math.max(1, min)
}

function addressError(email, minPrefix) {
  if (!normalizeMailboxEmail(email)) return '邮箱地址格式不正确'
  if (email.split('@')[0].length < minPrefix) return `邮箱前缀至少需要 ${minPrefix} 个字符`
  return ''
}

export function parseMailboxInput(text, domain, { minPrefix = 1 } = {}) {
  if (typeof text !== 'string') throw new Error('请输入邮箱名单')
  if (new TextEncoder().encode(text).byteLength > MAX_INPUT_BYTES) throw new Error('邮箱名单不能超过 1 MiB')
  const min = minimumPrefix(minPrefix)
  const defaultDomain = normalizeDomain(domain)
  const tokens = text.replace(/^\uFEFF/, '').split(/[\s,，;；]+/).filter(Boolean)
  const seen = new Set(), items = []
  for (const token of tokens) {
    const value = token.trim().toLowerCase()
    const candidate = value.includes('@') ? value : defaultDomain ? `${value}@${defaultDomain}` : value
    const email = normalizeMailboxEmail(candidate) || candidate
    if (seen.has(email)) continue
    seen.add(email)
    const error = !value.includes('@') && !defaultDomain ? '仅填写前缀时，请先选择受控域名' : addressError(email, min)
    items.push({ email, error })
  }
  return { items, inputCount: tokens.length, duplicates: tokens.length - items.length }
}

function integer(value, label, min, max) {
  const number = Number(value)
  if (value === '' || value === null || value === undefined || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}应为 ${min}～${max} 的整数`)
  }
  return number
}

export function generateMailboxEmails({ mode = 'random', domain, count, length = 12, prefix = '', start = 1, padding = 3, minPrefix = 1 } = {}) {
  const normalizedDomain = normalizeDomain(domain)
  if (!normalizedDomain) throw new Error('请选择有效的受控域名')
  const size = integer(count, '创建数量', 1, MAX_MAILBOXES)
  const min = minimumPrefix(minPrefix)
  const emails = []
  if (mode === 'sequence') {
    const first = integer(start, '起始编号', 0, Number.MAX_SAFE_INTEGER)
    const width = integer(padding, '补零位数', 0, 64)
    if (first > Number.MAX_SAFE_INTEGER - (size - 1)) throw new Error('结束编号超出安全整数范围')
    if (typeof prefix !== 'string') throw new Error('请输入合法的固定前缀')
    const fixed = prefix.trim().toLowerCase()
    for (let index = 0; index < size; index++) emails.push(`${fixed}${String(first + index).padStart(width, '0')}@${normalizedDomain}`)
  } else if (mode === 'random') {
    const width = integer(length, '随机前缀长度', 1, 64)
    if (width < min) throw new Error(`邮箱前缀至少需要 ${min} 个字符`)
    if (width < 3 && size > alphabet.length ** width) throw new Error('随机前缀过短，无法生成这么多不同地址，请增加长度')
    if (!globalThis.crypto?.getRandomValues) throw new Error('当前浏览器不支持安全随机生成，请使用编号或导入方式')
    const generated = new Set()
    let attempts = 0
    while (generated.size < size) {
      if (++attempts > Math.max(1000, size * 100)) throw new Error('随机前缀重复过多，请增加长度后重新生成')
      let local = ''
      while (local.length < width) {
        const bytes = new Uint8Array(Math.max(16, width - local.length))
        globalThis.crypto.getRandomValues(bytes)
        for (const byte of bytes) {
          if (byte < 252 && local.length < width) local += alphabet[byte % alphabet.length]
        }
      }
      generated.add(`${local}@${normalizedDomain}`)
    }
    emails.push(...generated)
  } else throw new Error('请选择随机生成或连续编号')
  for (const email of emails) {
    const error = addressError(email, min)
    if (error) throw new Error(`${email}：${error}`)
  }
  return emails
}

export function createBatchMailboxState(emails) {
  if (!Array.isArray(emails) || !emails.length || emails.length > MAX_MAILBOXES) throw new Error(`每批请输入 1～${MAX_MAILBOXES} 个邮箱`)
  const unique = new Set()
  for (const email of emails) {
    const normalized = normalizeMailboxEmail(email)
    if (!normalized) throw new Error(`邮箱地址格式不正确：${String(email)}`)
    unique.add(normalized)
  }
  return {
    items: [...unique].map(email => ({ email, status: 'waiting', mailboxId: '', error: null })),
    running: false, paused: false, error: '',
  }
}

export function getBatchCounts(state) {
  const counts = { total: state?.items?.length || 0, created: 0, existing: 0, failed: 0, unknown: 0, waiting: 0, completed: 0 }
  for (const item of state?.items || []) {
    if (['created', 'existing', 'failed', 'unknown', 'waiting'].includes(item.status)) counts[item.status]++
  }
  counts.completed = counts.created + counts.existing + counts.failed
  return counts
}

function checkedResults(response, emails) {
  if (!response || !Array.isArray(response.items) || response.items.length !== emails.length) throw new Error('服务器返回的批量结果不完整')
  const expected = new Set(emails), seen = new Set(), results = new Map()
  for (const item of response.items) {
    const email = normalizeMailboxEmail(item?.email)
    if (!email || !expected.has(email) || seen.has(email) || !['created', 'existing', 'failed'].includes(item?.status)) {
      throw new Error('服务器返回的批量结果与提交名单不一致')
    }
    if (item.status !== 'failed' && (typeof item.mailboxId !== 'string' || !item.mailboxId)) throw new Error('服务器返回的邮箱标识不完整')
    seen.add(email)
    results.set(email, {
      status: item.status,
      mailboxId: item.status === 'failed' ? '' : item.mailboxId,
      error: item.status === 'failed' ? {
        code: typeof item.error?.code === 'string' ? item.error.code : 'CREATE_FAILED',
        message: typeof item.error?.message === 'string' && item.error.message ? item.error.message : '创建失败，请重试',
      } : null,
    })
  }
  return results
}

export async function runMailboxBatch(state, send, { retryFailed = false, onBatch = () => {} } = {}) {
  if (state.running) return state
  if (!Array.isArray(state.items) || !state.items.length || state.items.length > MAX_MAILBOXES) throw new Error(`每批请输入 1～${MAX_MAILBOXES} 个邮箱`)
  const allEmails = state.items.map(item => item.email)
  if (allEmails.some(email => normalizeMailboxEmail(email) !== email) || new Set(allEmails).size !== allEmails.length) throw new Error('批次名单已改变，请重新预览')
  const eligible = new Set(['waiting', 'unknown', ...(retryFailed ? ['failed'] : [])])
  const pending = state.items.filter(item => eligible.has(item.status)).sort((left, right) =>
    Number(left.email.split('@')[0].includes('+')) - Number(right.email.split('@')[0].includes('+')))
  state.running = true
  state.paused = false
  state.error = ''
  try {
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + BATCH_SIZE)
      const emails = chunk.map(item => item.email)
      let result
      try {
        result = checkedResults(await send([...emails]), emails)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : '请求失败'
        state.error = `本次请求结果未确认，后续创建已暂停。${detail}。请重试未确认及未提交的地址。`
        state.paused = true
        for (const item of chunk) {
          item.status = 'unknown'
          item.error = { code: 'RESULT_UNCONFIRMED', message: '结果未确认，重试会自动识别已有邮箱' }
          item.mailboxId = ''
        }
      }
      if (result) for (const item of chunk) Object.assign(item, result.get(item.email))
      // A list-refresh failure must never turn an acknowledged creation into an unknown write.
      try { await onBatch() } catch { /* Creation results remain authoritative. */ }
      if (state.paused) break
    }
  } finally { state.running = false }
  return state
}
