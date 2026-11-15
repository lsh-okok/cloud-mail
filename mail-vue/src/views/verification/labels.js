export const statusLabel = status => ({ queued: '排队中', running: '运行中', completed: '已完成', stopped: '已停止', failed: '任务失败' }[status] || status)
export const statusType = status => ({ queued: 'info', running: 'primary', completed: 'success', stopped: 'warning', failed: 'danger' }[status] || 'info')
export const resultLabel = result => ({ passed: '通过', failed: '失败', pending: '待确认' }[result] || result)
export const phaseLabel = phase => ({ queued: '等待处理', checking: '检查链接', sending: '发送测试邮件', waiting: '等待收信', finished: '处理结束', interrupted: '已中断' }[phase] || phase)
export const isActive = task => ['queued', 'running'].includes(task?.status)
export const formatTime = value => value ? new Date(value).toLocaleString() : '—'
export const defaultOptions = () => ({ mailboxIds: [], sample: 1, timeoutSeconds: 10, concurrency: 5, waitSeconds: 60, sendIntervalMs: 1000 })
export function snapshotOptions(form) {
  const { sample, timeoutSeconds, concurrency, waitSeconds, sendIntervalMs } = form
  return { sample, timeoutSeconds, concurrency, waitSeconds, sendIntervalMs, ...(form.mailboxIds.length ? { mailboxIds: [...form.mailboxIds] } : {}) }
}
