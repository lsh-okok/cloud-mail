export async function copyText(value) {
  const text = String(value ?? '')
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Local HTTP sites and browsers denying Clipboard access use the selection fallback.
    }
  }

  const focused = document.activeElement
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const inputSelection = focused && typeof focused.selectionStart === 'number'
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
    : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('style', 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px;')

  try {
    const container = focused?.closest?.('dialog, [role="dialog"]') || document.body
    container.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('Copy was not accepted')
  } catch {
    throw new Error('复制失败，请手动选择并复制链接')
  } finally {
    textarea.remove()
    try {
      if (focused?.isConnected) focused.focus({ preventScroll: true })
      if (inputSelection && focused?.isConnected) {
        focused.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction)
      } else if (selection) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    } catch {
      // A view may have changed while the browser was handling the clipboard operation.
    }
  }
}
