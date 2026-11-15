import { onBeforeUnmount, ref, shallowRef } from 'vue'

export function useFeatureResource(load, initialData = null) {
  const data = shallowRef(initialData), loading = ref(false), error = ref('')
  let controller, sequence = 0
  function cancel() { sequence++; controller?.abort(); loading.value = false }
  async function refresh({ quiet = false } = {}) {
    const current = ++sequence
    controller?.abort(); controller = new AbortController()
    if (!quiet) loading.value = true
    try {
      const result = await load(controller.signal)
      if (sequence !== current) return
      data.value = result; error.value = ''
      return result
    } catch (cause) {
      if (sequence === current && cause.name !== 'AbortError') error.value = cause.message || '加载失败，请重试'
    } finally { if (sequence === current) loading.value = false }
  }
  onBeforeUnmount(cancel)
  return { data, loading, error, refresh, cancel }
}
