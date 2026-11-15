import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue'

export function useFeaturePolling(refresh, { enabled = () => true, cancel = () => {}, interval = 5000 } = {}) {
  let timer, active = false
  function stop() { clearTimeout(timer); timer = undefined }
  async function tick() {
    stop()
    if (!active || document.hidden) return
    if (enabled()) await refresh()
    if (active && !document.hidden) timer = setTimeout(tick, interval)
  }
  function start() { active = true; stop(); if (!document.hidden) timer = setTimeout(tick, interval) }
  function pause() { active = false; stop(); cancel() }
  function visibility() {
    if (document.hidden) { stop(); cancel() }
    else if (active) void tick()
  }
  onMounted(() => { document.addEventListener('visibilitychange', visibility); start() })
  onActivated(start)
  onDeactivated(pause)
  onBeforeUnmount(() => { pause(); document.removeEventListener('visibilitychange', visibility) })
}
