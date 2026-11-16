export function parseRedemptionCodes(text) {
  return [...new Set(String(text || '').replace(/^\uFEFF/, '').split(/[\s,，;；]+/u).map(value => value.trim()).filter(Boolean))]
}

export function createRedemptionKey() {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function saveRedemptionText(text, filename) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const cardStatusLabel = status => ({ unissued: '未生成', unused: '未核销', redeemed: '已核销', disabled: '已停用', revoked: '已作废' }[status] || status || '未生成')
export const cardStatusType = status => ({ unused: 'success', redeemed: 'info', disabled: 'warning', revoked: 'danger' }[status] || 'info')
export const orderStatusLabel = status => ({ success: '全部成功', partial: '部分成功', failed: '全部失败' }[status] || status || '—')
export const orderStatusType = status => ({ success: 'success', partial: 'warning', failed: 'danger' }[status] || 'info')
export const redemptionTime = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '—'
export function redemptionFileSize(size) {
  if (!Number.isFinite(Number(size))) return '—'
  return Number(size) < 1024 ? `${size} B` : Number(size) < 1024 * 1024 ? `${(Number(size) / 1024).toFixed(1)} KB` : `${(Number(size) / 1024 / 1024).toFixed(1)} MB`
}
