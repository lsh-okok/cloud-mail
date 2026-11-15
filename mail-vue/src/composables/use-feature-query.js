import { onBeforeUnmount, ref } from 'vue'

export function useFeatureQuery(load) {
  const items = ref([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref('')
  let controller
  let sequence = 0

  async function refresh() {
    const current = ++sequence
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const result = await load(controller.signal)
      if (sequence !== current) return
      items.value = result.items
      total.value = result.total
      return result
    } catch (cause) {
      if (sequence === current && cause.name !== 'AbortError') {
        error.value = cause.message || '加载失败，请重试'
        items.value = []
        total.value = 0
      }
    } finally {
      if (sequence === current) loading.value = false
    }
  }

  onBeforeUnmount(() => {
    sequence++
    controller?.abort()
  })
  return { items, total, loading, error, refresh }
}
