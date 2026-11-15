<template>
  <el-dialog v-model="visible" title="批量创建邮箱" width="min(880px, calc(100vw - 24px))" class="batch-mailboxes-dialog"
    :close-on-click-modal="false" :close-on-press-escape="!running" :show-close="!running">
    <p class="batch-intro">每次最多创建 1000 个邮箱，统一归当前管理员管理，可在收件箱中使用。</p>

    <template v-if="!batchState">
      <el-alert v-if="domainsError" :title="domainsError" type="error" :closable="false" show-icon>
        <el-button text :loading="domainsLoading" @click="loadDomains">重新加载域名</el-button>
      </el-alert>
      <el-alert v-else-if="domainsLoaded && !domains.length" title="当前没有可用的受控域名，请先配置收件域名。" type="warning" :closable="false" />
      <el-tabs v-model="inputMode">
        <el-tab-pane label="自动生成" name="generate" />
        <el-tab-pane label="导入名单" name="import" />
      </el-tabs>
      <p v-if="domainsLoading" class="batch-help" role="status">正在加载受控域名…</p>
      <el-form v-if="domainsLoaded && domains.length" label-position="top" :disabled="fileLoading" @submit.prevent="preparePreview">
        <div class="batch-fields">
          <el-form-item :label="inputMode === 'import' ? '前缀使用的域名' : '邮箱域名'">
            <el-select v-model="form.domain" placeholder="选择受控域名" :loading="domainsLoading" :disabled="!domainsLoaded">
              <el-option v-for="domain in domains" :key="domain" :label="`@${domain}`" :value="domain" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="inputMode === 'generate'" label="生成方式">
            <el-radio-group v-model="form.mode"><el-radio-button value="random">随机前缀</el-radio-button><el-radio-button value="sequence">连续编号</el-radio-button></el-radio-group>
          </el-form-item>
        </div>
        <template v-if="inputMode === 'generate'">
          <div class="batch-fields">
            <el-form-item label="创建数量"><el-input-number v-model="form.count" :min="1" :max="MAX_MAILBOXES" :precision="0" /></el-form-item>
            <el-form-item v-if="form.mode === 'random'" label="随机前缀长度"><el-input-number v-model="form.length" :min="Math.max(1, minPrefix)" :max="64" :precision="0" /></el-form-item>
            <el-form-item v-else label="固定前缀"><el-input v-model="form.prefix" placeholder="例如 test" maxlength="63" autocomplete="off" /></el-form-item>
          </div>
          <div v-if="form.mode === 'sequence'" class="batch-fields">
            <el-form-item label="起始编号"><el-input-number v-model="form.start" :min="0" :max="Number.MAX_SAFE_INTEGER" :precision="0" /></el-form-item>
            <el-form-item label="编号位数（不足补零）"><el-input-number v-model="form.padding" :min="1" :max="64" :precision="0" /></el-form-item>
          </div>
          <p class="batch-help">{{ form.mode === 'random' ? '使用随机小写字母和数字生成地址。' : '例如固定前缀 test、起始编号 1、编号位数 3，将生成 test001、test002。' }} 邮箱前缀至少 {{ minPrefix }} 个字符。</p>
        </template>
        <template v-else>
          <el-form-item label="邮箱名单">
            <el-input v-model="form.text" type="textarea" :rows="6" placeholder="test001&#10;test002@example.com&#10;每行一个地址，也可用空格、逗号或分号分隔" />
          </el-form-item>
          <div class="file-row">
            <el-button :loading="fileLoading" :disabled="domainsLoading" @click="fileInput.click()">从 TXT 追加名单</el-button>
            <input ref="fileInput" type="file" accept=".txt,text/plain" multiple hidden @change="appendFiles" />
            <span class="batch-help">UTF-8 文本，总大小最多 1 MiB。完整邮箱保留原域名，单独前缀使用上方域名。</span>
          </div>
        </template>
        <el-button native-type="submit" :disabled="!domainsLoaded || !domains.length || fileLoading">{{ preview ? '重新预览名单' : '预览邮箱名单' }}</el-button>
      </el-form>
    </template>

    <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon />
    <template v-if="preview || batchState">
      <div class="batch-summary" aria-live="polite">
        <template v-if="batchState">
          <strong>{{ running ? '正在创建' : batchState.paused ? '已暂停' : '处理完成' }} · {{ counts.completed }} / {{ counts.total }}</strong>
          <span>新增 {{ counts.created }}</span><span>已存在 {{ counts.existing }}</span><span>失败 {{ counts.failed }}</span>
          <span v-if="counts.unknown">待确认 {{ counts.unknown }}</span><span v-if="counts.waiting">未提交 {{ counts.waiting }}</span>
        </template>
        <template v-else>
          <strong>预览 {{ preview.items.length }} 个邮箱</strong><span>已去重 {{ preview.duplicates }} 项</span><span :class="{ 'batch-error': invalidCount }">格式问题 {{ invalidCount }} 项</span>
        </template>
      </div>
      <el-progress v-if="batchState" :percentage="progress" :status="batchState.paused ? 'warning' : !running && !counts.failed ? 'success' : undefined" />
      <el-alert v-if="batchState?.paused" title="已暂停后续提交，请重试继续" type="warning" :closable="false" show-icon>
        <p>{{ batchState.error }}</p><p>待确认的地址可能已创建；重试将使用原名单，已创建的邮箱会识别为已存在。</p>
      </el-alert>
      <p v-if="running" class="batch-help" role="status">正在分批创建，请保持此页面打开。</p>
      <p v-else-if="!batchState && invalidCount" class="batch-help batch-error">请修改名单中的问题地址，再重新预览。</p>
      <div class="batch-results-actions" v-if="batchState">
        <el-button :disabled="running || !successfulEmails.length" @click="copySuccessful">复制成功地址</el-button>
        <el-button :disabled="running || !successfulEmails.length" @click="exportSuccessful">导出成功地址 TXT</el-button>
      </div>
      <el-table :data="pageRows" row-key="email" class="batch-table" max-height="340" empty-text="暂无邮箱">
        <el-table-column label="邮箱地址" prop="email" min-width="240" show-overflow-tooltip />
        <el-table-column label="状态" width="88"><template #default="{ row }"><el-tag :type="tagType(row)">{{ statusText(row) }}</el-tag></template></el-table-column>
        <el-table-column label="说明" min-width="200"><template #default="{ row }"><span :class="{ 'batch-error': row.status === 'failed' || row.error }">{{ rowMessage(row) }}</span></template></el-table-column>
      </el-table>
      <el-pagination v-if="rows.length > 10" v-model:current-page="resultPage" :page-size="10" :total="rows.length" layout="total, prev, pager, next" :pager-count="5" size="small" />
    </template>
    <template #footer>
      <div class="batch-footer">
        <el-button :disabled="running || fileLoading" @click="visible = false">{{ batchState ? '关闭' : '取消' }}</el-button>
        <template v-if="batchState">
          <el-button :disabled="running" @click="resetBatch">新建一批</el-button>
          <el-button v-if="batchState.paused" type="primary" :loading="running" @click="run(false)">重试并继续</el-button>
          <el-button v-if="counts.failed" :disabled="running" @click="run(true)">重试失败项</el-button>
        </template>
        <el-button v-else type="primary" :disabled="!canStart" @click="startBatch">{{ preview ? `确认创建 ${preview.items.length} 个邮箱` : '确认创建' }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'
import { useAccountStore } from '@/store/account.js'
import { copyText } from '@/utils/copy-text.js'
import { MAX_MAILBOXES, parseMailboxInput, generateMailboxEmails, createBatchMailboxState, runMailboxBatch, getBatchCounts } from './batch-mailboxes.js'

const emit = defineEmits(['changed'])
const accountStore = useAccountStore()
const visible = ref(false), inputMode = ref('generate'), formError = ref(''), preview = ref(null), batchState = ref(null)
const domains = ref([]), domainsLoaded = ref(false), domainsLoading = ref(false), domainsError = ref(''), minPrefix = ref(1)
const fileInput = ref(null), fileLoading = ref(false), resultPage = ref(1)
const form = reactive({ domain: '', mode: 'random', count: 10, length: 12, prefix: 'test', start: 1, padding: 3, text: '' })
const running = computed(() => !!batchState.value?.running)
const counts = computed(() => batchState.value ? getBatchCounts(batchState.value) : null)
const rows = computed(() => batchState.value?.items || preview.value?.items || [])
const pageRows = computed(() => rows.value.slice((resultPage.value - 1) * 10, resultPage.value * 10))
const invalidCount = computed(() => preview.value?.items.filter(item => item.error).length || 0)
const canStart = computed(() => !!preview.value?.items.length && !invalidCount.value && domainsLoaded.value && !domainsLoading.value && !fileLoading.value)
const progress = computed(() => counts.value?.total ? Math.round(counts.value.completed / counts.value.total * 100) : 0)
const successfulEmails = computed(() => batchState.value?.items.filter(item => ['created', 'existing'].includes(item.status)).map(item => item.email) || [])
let activeController, disposed = false

watch([form, inputMode], () => {
  if (!batchState.value) { preview.value = null; formError.value = ''; resultPage.value = 1 }
}, { deep: true })

async function open() {
  visible.value = true
  if (!batchState.value) await loadDomains()
}
async function loadDomains() {
  if (domainsLoading.value) return
  domainsLoaded.value = false; domainsLoading.value = true; domainsError.value = ''
  try {
    const result = await adminFeatureRequest('/admin/mailboxes/domains')
    if (disposed) return
    domains.value = [...new Set(result.domains.map(value => String(value).replace(/^@/, '').toLowerCase()))]
    minPrefix.value = Math.max(1, Number(result.minEmailPrefix) || 1)
    if (!domains.value.includes(form.domain)) form.domain = domains.value[0] || ''
    form.length = Math.max(form.length || 12, minPrefix.value)
    preview.value = null; domainsLoaded.value = true
  } catch (cause) { domainsError.value = cause.message || '域名加载失败，请重试' }
  finally { domainsLoading.value = false }
}
async function appendFiles(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  if (!files.length) return
  if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) + new TextEncoder().encode(form.text).length > 1024 * 1024) {
    formError.value = '一次最多选择 10 个 TXT，名单总大小不得超过 1 MiB'; return
  }
  fileLoading.value = true; formError.value = ''
  try {
    const text = (await Promise.all(files.map(async file => new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())))).join('\n')
    form.text += `${form.text ? '\n' : ''}${text}`
  } catch { formError.value = '文件读取失败，请使用 UTF-8 编码的 TXT 文件' }
  finally { fileLoading.value = false }
}
function preparePreview() {
  formError.value = ''; preview.value = null; resultPage.value = 1
  if (!domainsLoaded.value || !domains.value.length) { formError.value = '请先加载可用的受控域名'; return }
  try {
    const text = inputMode.value === 'generate' ? generateMailboxEmails({ ...form, minPrefix: minPrefix.value }).join('\n') : form.text
    const result = parseMailboxInput(text, form.domain, { minPrefix: minPrefix.value })
    if (!result.items.length) throw new Error('请输入至少一个邮箱地址或前缀')
    if (result.items.length > MAX_MAILBOXES) throw new Error(`去重后有 ${result.items.length} 个地址，每次最多创建 ${MAX_MAILBOXES} 个`)
    for (const item of result.items) {
      if (!item.error && !domains.value.includes(item.email.split('@')[1])) item.error = '该域名不在受控收件域名中'
    }
    preview.value = result
  } catch (cause) { formError.value = cause.message }
}
async function startBatch() {
  if (!canStart.value || running.value) return
  batchState.value = createBatchMailboxState(preview.value.items.map(item => item.email))
  await run(false)
}
async function run(retryFailed) {
  if (!batchState.value || running.value) return
  formError.value = ''
  activeController = new AbortController()
  const controller = activeController
  try {
    await runMailboxBatch(batchState.value, async emails => {
      // The controller also stops any subsequent chunk after navigation away.
      if (controller.signal.aborted) throw new Error('已离开页面，创建结果待确认')
      return adminFeatureRequest('/admin/mailboxes/batch', { method: 'POST', data: { emails }, signal: controller.signal })
    }, { retryFailed, onBatch: () => {
      if (!disposed) { accountStore.listRevision++; emit('changed') }
    } })
  } catch (cause) { formError.value = cause.message || '批量创建失败，请重试' }
  finally { if (activeController === controller) activeController = undefined }
}
async function resetBatch() {
  if (running.value) return
  try {
    await ElMessageBox.confirm('新建一批会清空当前名单和结果。需要的地址请先复制或导出，已创建的邮箱会保留。', '新建一批', { confirmButtonText: '新建一批', cancelButtonText: '保留当前结果', type: 'warning' })
    batchState.value = null; preview.value = null; formError.value = ''; resultPage.value = 1
    await loadDomains()
  } catch { /* Keep the current result when cancelled. */ }
}
function statusText(row) {
  if (!batchState.value) return row.error ? '待修改' : '待创建'
  return { waiting: '未提交', unknown: '待确认', created: '已新增', existing: '已存在', failed: '失败' }[row.status] || '待确认'
}
function tagType(row) {
  if (!batchState.value) return row.error ? 'danger' : 'info'
  return { waiting: 'info', unknown: 'warning', created: 'success', existing: 'info', failed: 'danger' }[row.status] || 'warning'
}
function rowMessage(row) {
  if (row.error) return typeof row.error === 'string' ? row.error : row.error.message
  return { created: '已加入收件箱和主邮箱列表', existing: '已有主邮箱，保留原配置', waiting: '等待分批提交', unknown: '请使用原名单重试确认结果' }[row.status] || '格式检查通过，创建时将检查占用情况'
}
async function copySuccessful() {
  try { await copyText(successfulEmails.value.join('\n')); ElMessage.success('成功地址已复制') }
  catch { ElMessage.error('复制失败，请使用导出 TXT 保存地址') }
}
function exportSuccessful() {
  const blob = new Blob([successfulEmails.value.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = `mailboxes-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
onBeforeUnmount(() => { disposed = true; activeController?.abort() })
defineExpose({ open })
</script>

<style scoped>
:global(.batch-mailboxes-dialog){--el-dialog-margin-top:24px;max-height:calc(100dvh - 48px);display:flex;flex-direction:column}:global(.batch-mailboxes-dialog .el-dialog__body){min-height:0;overflow:auto}:global(.batch-mailboxes-dialog .el-dialog__header),:global(.batch-mailboxes-dialog .el-dialog__footer){flex-shrink:0}
.batch-intro{margin:0 0 16px;color:var(--el-text-color-regular);line-height:1.6}.batch-fields{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}.batch-fields :deep(.el-select),.batch-fields :deep(.el-input-number){width:100%}.batch-help{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:0 0 14px}.batch-error{color:var(--el-color-danger)}.file-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.file-row .batch-help{margin:0}.batch-summary{display:flex;flex-wrap:wrap;gap:8px 18px;margin:22px 0 12px;font-size:13px}.batch-summary strong{color:var(--el-text-color-primary)}.batch-results-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.batch-results-actions .el-button+.el-button{margin-left:0}.batch-table{width:100%;margin-top:14px}.batch-footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.batch-footer .el-button+.el-button{margin-left:0}.el-alert{margin:12px 0}.el-pagination{justify-content:flex-end;margin-top:14px;flex-wrap:wrap;row-gap:8px}.el-progress{margin-bottom:14px}
@media(max-width:600px){.batch-fields{grid-template-columns:1fr;gap:0}.batch-footer>.el-button{flex:1;min-width:120px}.batch-results-actions>.el-button{flex:1}.el-pagination{justify-content:center}.batch-summary{gap:8px 12px}.batch-summary strong{width:100%}}
</style>
