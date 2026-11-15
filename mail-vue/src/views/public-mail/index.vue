<template>
  <main class="public-mail-page">
    <div class="public-shell">
      <header><div><p class="eyebrow">CLOUD MAIL</p><h1>子邮箱收件箱</h1><p class="recipient">{{ recipient || '正在打开收件链接' }}</p></div><el-button :loading="loading" @click="load">刷新邮件</el-button></header>
      <div class="controls"><el-radio-group v-model="mode" @change="load"><el-radio-button value="latest">最新一封</el-radio-button><el-radio-button value="recent">最近邮件</el-radio-button></el-radio-group><el-select v-if="mode === 'recent'" v-model="order" @change="load" style="width:140px"><el-option label="最新优先" value="latest" /><el-option label="最早优先" value="oldest" /></el-select></div>
      <section v-loading="loading" class="messages-region">
        <div v-if="error" class="public-state"><h2>{{ errorTitle }}</h2><p>{{ error }}</p><el-button v-if="retryable" type="primary" @click="load">重新尝试</el-button></div>
        <el-empty v-else-if="!loading && !messages.length" description="暂时没有符合此收件地址的邮件" />
        <article v-for="message in messages" :key="message.id" class="public-message"><div class="message-heading"><h2>{{ message.subject || '（无主题）' }}</h2><div class="message-meta"><span>发件人：{{ sender(message.from) }}</span><time>{{ formatDate(message.receivedAt) }}</time></div></div><SafeMailBody :html="message.html || ''" :text="message.text || ''" /></article>
        <div v-if="nextCursor && mode === 'recent' && !error" class="load-more"><el-button :loading="loading" @click="loadMore">加载更多邮件</el-button></div>
      </section>
      <footer>此链接仅显示对应子邮箱的邮件。请妥善保存链接，避免泄露。</footer>
    </div>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { publicFeatureRequest } from '@/request/features.js'
import SafeMailBody from '@/components/safe-mail-body/index.vue'

const route = useRoute()
const mode = ref(route.query.recent === '1' ? 'recent' : 'latest')
const order = ref('latest'), recipient = ref(''), messages = ref([]), loading = ref(true), error = ref(''), status = ref(0)
const nextCursor = ref(null)
let controller, sequence = 0
const errorTitle = computed(() => ({ 404: '链接不存在或已失效', 410: '收件链接已过期', 429: '请求繁忙，请稍后再试', 502: '邮件服务暂时无法读取', 503: '取信服务尚未就绪' }[status.value] || '暂时无法打开收件箱'))
const retryable = computed(() => ![404, 410].includes(status.value))
function sender(value) { return typeof value === 'string' ? value : (value?.address || value?.email || value?.name || '未知发件人') }
function formatDate(value) { return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '' }
function messagePath() {
  if (route.params.token) return `/mailboxes/${encodeURIComponent(route.params.token)}/messages`
  return `/mailboxes/${encodeURIComponent(route.params.platform)}/${encodeURIComponent(route.params.publicId)}/${encodeURIComponent(route.params.recipient)}/messages`
}
function load() { return fetchPage(false) }
function loadMore() { if (!loading.value && nextCursor.value) return fetchPage(true) }
async function fetchPage(append) {
  const current = ++sequence
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = ''; status.value = 0
  const cursor = append ? nextCursor.value : undefined
  if (!append) { messages.value = []; nextCursor.value = null }
  try {
    const result = await publicFeatureRequest(messagePath(), { query: { limit: mode.value === 'latest' ? 1 : 20, order: order.value, cursor }, signal: controller.signal })
    if (sequence !== current) return
    recipient.value = result.recipient
    messages.value = append ? [...messages.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor || null
  } catch (cause) {
    if (sequence === current && cause.name !== 'AbortError') { error.value = cause.message || '连接失败，请检查网络后重试'; status.value = cause.status || 0 }
  } finally { if (sequence === current) loading.value = false }
}
watch(() => route.path, () => { recipient.value = ''; load() })
onBeforeUnmount(() => { sequence++; controller?.abort() })
load()
</script>

<style scoped>
.public-mail-page { min-height: 100dvh; box-sizing: border-box; padding: 48px 24px; background: var(--el-fill-color-lighter); color: var(--el-text-color-primary); }
.public-shell { max-width: 980px; margin: auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 30px; }
.eyebrow { color: var(--el-color-primary); letter-spacing: .18em; font-size: 11px; font-weight: 700; margin: 0 0 10px; }
h1 { font-size: 28px; letter-spacing: -.025em; margin: 0 0 10px; }
.recipient { margin: 0; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.controls { display: flex; gap: 14px; justify-content: space-between; flex-wrap: wrap; margin-bottom: 18px; }
.messages-region { min-height: 240px; }
.public-message { border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); padding: 24px; margin-bottom: 20px; }
.message-heading { margin-bottom: 22px; }
.message-heading h2 { font-size: 19px; margin: 0 0 12px; overflow-wrap: anywhere; }
.message-meta { color: var(--el-text-color-secondary); display: flex; flex-wrap: wrap; gap: 10px 24px; font-size: 13px; overflow-wrap: anywhere; }
.public-state { text-align: center; padding: 50px 20px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); }
.public-state h2 { font-size: 19px; }
.public-state p { color: var(--el-text-color-secondary); line-height: 1.7; }
footer { text-align: center; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.7; padding-top: 18px; }
.load-more { text-align: center; padding: 8px 0; }
@media (max-width: 600px) { .public-mail-page { padding: 28px 14px; } header { gap: 10px; align-items: flex-start; } h1 { font-size: 23px; } .public-message { padding: 16px; } header .el-button { margin-top: 21px; } }
</style>
