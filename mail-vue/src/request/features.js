import { sha256Hex } from '@/utils/sha256.js'

// The public client never sends the administrator's Authorization header.
function apiRoot() {
  const configured = import.meta.env.VITE_BASE_URL || 'api'
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/$/, '')
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const path = configured.replace(/^\/+|\/+$/g, '')
  if (base && `/${path}`.startsWith(`${base}/`)) return `/${path}`
  return `${base}/${path}`
}

export const featureApiRoot = apiRoot()
let sessionToken = ''
let csrfToken = ''
let sessionRequest

export class FeatureRequestError extends Error {
  constructor(response, payload) {
    super(payload?.error?.message || `请求失败（${response.status}）`)
    this.status = response.status
    this.code = payload?.error?.code || 'REQUEST_FAILED'
    this.details = payload?.error?.details
  }
}

function endpoint(path, query) {
  const url = new URL(`${featureApiRoot}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, value)
  }
  return url
}

async function send(path, { method = 'GET', query, data, signal, admin = true, csrf, token } = {}) {
  const headers = { Accept: 'application/json' }
  if (admin && token) headers.Authorization = token
  if (csrf) headers['X-CSRF-Token'] = csrf
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(endpoint(path, query), {
    method, headers, signal, credentials: 'omit', cache: 'no-store',
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  let payload
  try { payload = await response.json() } catch {
    throw new FeatureRequestError(response, { error: { message: '服务器未返回有效结果，请稍后重试' } })
  }
  if (!response.ok) throw new FeatureRequestError(response, payload)
  return payload.data
}

async function getCsrf(token) {
  if (sessionToken !== token) {
    sessionToken = token
    csrfToken = ''
    sessionRequest = undefined
  }
  if (csrfToken) return csrfToken
  if (!sessionRequest) {
    const request = send('/admin/session', { token }).then(session => {
      if (sessionToken === token) csrfToken = session.csrfToken
      return session.csrfToken
    })
    sessionRequest = request
    request.finally(() => {
      if (sessionRequest === request) sessionRequest = undefined
    }).catch(() => {})
  }
  return sessionRequest
}

export async function adminFeatureRequest(path, options = {}) {
  const token = localStorage.getItem('token') || ''
  const write = !['GET', 'HEAD'].includes(options.method || 'GET')
  const csrf = write ? await getCsrf(token) : undefined
  try {
    return await send(path, { ...options, token, csrf })
  } catch (error) {
    // CSRF failures happen before mutation. Other failed writes are never retried here.
    if (write && error.status === 403 && /csrf/i.test(error.code)) {
      csrfToken = ''
      return send(path, { ...options, token, csrf: await getCsrf(token) })
    }
    throw error
  }
}

export function publicFeatureRequest(path, options = {}) {
  return send(path, { ...options, admin: false })
}

export async function downloadFeatureExport(path, query, { filename = `recipient-links-${Date.now()}.txt` } = {}) {
  const token = localStorage.getItem('token') || ''
  const response = await fetch(endpoint(path, query), {
    headers: { Authorization: token }, credentials: 'omit', cache: 'no-store',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new FeatureRequestError(response, payload)
  }
  const buffer = await response.arrayBuffer()
  const size = response.headers.get('Content-Length')
  if (!response.headers.get('Content-Encoding') && size !== null && Number(size) !== buffer.byteLength) throw new Error('导出文件未完整下载，请重试')
  const expectedHash = response.headers.get('X-Content-SHA256')
  if (!expectedHash) throw new Error('导出响应缺少完整性校验，未保存文件')
  const actualHash = await sha256Hex(buffer)
  if (actualHash !== expectedHash.toLowerCase()) throw new Error('导出文件校验失败，请重试')
  const blob = new Blob([buffer], { type: response.headers.get('Content-Type') || 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const disposition = response.headers.get('Content-Disposition') || ''
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const plainName = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1]
  let serverName = plainName
  if (encodedName) { try { serverName = decodeURIComponent(encodedName) } catch { /* Use the safe provided fallback. */ } }
  link.download = String(serverName || filename).replace(/[\\/\u0000-\u001f]/g, '_')
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createRequestKey() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
