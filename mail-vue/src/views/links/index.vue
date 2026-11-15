<template>
  <section class="feature-page">
    <header class="page-heading"><div><h1>子邮箱收件链接</h1><p>选择实际取信的主邮箱，为 a1、a2、a3 等子邮箱分别生成链接，每个链接只读取对应完整地址的邮件。</p></div><div class="heading-actions"><el-button @click="platformRef.open()">平台规则</el-button><el-button type="primary" :disabled="capabilities && !capabilities.linkEncryption" @click="openCreate">生成子邮箱链接</el-button></div></header>
    <el-alert title="支持将 iCloud 等子地址转发到所选主邮箱，按原始收件人/抄送（To/Cc）识别对应地址。转发邮件缺失原始 To/Cc，或子地址仅在密送（Bcc）中时，无法识别。生成链接不会自动设置转发。" type="info" :closable="false" />
    <el-alert v-if="capabilities && !capabilities.linkEncryption" title="服务器尚未配置链接 Token 加密密钥，暂时不能生成链接；已有链接仍按其访问规则取信。" type="warning" :closable="false" />
    <div class="toolbar"><el-select v-model="query.mailboxId" clearable filterable remote :remote-method="findMailboxes" :loading="mailboxesLoading" placeholder="搜索并选择主邮箱" @change="search"><el-option v-for="mailbox in mailboxOptions" :key="mailbox.id" :value="mailbox.id" :label="`${mailbox.email}${mailbox.enabled ? '' : '（停用）'}`" /></el-select><el-input v-model="query.q" clearable placeholder="搜索子邮箱地址或收件链接" @keyup.enter="search" @clear="search" /><el-button @click="search">查询</el-button><el-button :loading="loading" @click="refresh">刷新</el-button><el-button :loading="exporting" @click="exportLinks">导出全部筛选结果</el-button></div>
    <div class="toolbar"><el-select v-model="query.platformId" clearable placeholder="按平台筛选" @change="search"><el-option label="全部平台（未限制）" value="p0" /><el-option v-for="platform in platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select><el-button :disabled="!selectedIds.length" @click="openBatch()">批量操作（已选 {{ selectedIds.length }}）</el-button><el-button v-if="selectedIds.length" @click="clearSelection">清空选择</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="refresh">重新加载</el-button></el-alert>
    <div class="list-region" v-loading="loading">
      <el-table ref="tableRef" class="desktop-links" :data="items" row-key="id" empty-text="暂无子邮箱链接" @selection-change="onSelection">
        <el-table-column type="selection" width="45" />
        <el-table-column label="子邮箱完整地址" min-width="220"><template #default="{ row }"><strong>{{ row.recipient }}</strong></template></el-table-column>
        <el-table-column prop="mailboxEmail" label="取信主邮箱" min-width="200" />
        <el-table-column label="平台" min-width="130"><template #default="{ row }">{{ row.platformName || '全部平台' }}</template></el-table-column>
        <el-table-column label="有效期" min-width="160"><template #default="{ row }"><span :class="{ expired: isExpired(row) }">{{ displayExpiry(row.expiresAt) }}</span></template></el-table-column>
        <el-table-column label="访问（页面 / JSON）" min-width="150"><template #default="{ row }">{{ row.pageVisits || 0 }} / {{ row.jsonVisits || 0 }}</template></el-table-column>
        <el-table-column label="操作" width="180" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button link type="primary" @click="copy(row.pageUrl)">复制链接</el-button><el-dropdown @command="command => linkAction(command, row)"><el-button link type="primary">更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="open">打开收件页</el-dropdown-item><el-dropdown-item command="json">复制 JSON 地址</el-dropdown-item><el-dropdown-item command="expiry">修改有效期</el-dropdown-item><el-dropdown-item command="platform">修改平台</el-dropdown-item><el-dropdown-item command="delete" divided>删除链接</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></template></el-table-column>
      </el-table>
      <div class="mobile-links"><el-empty v-if="!loading && !items.length && !error" description="暂无子邮箱链接" /><article class="link-card" v-for="item in items" :key="item.id"><div class="card-title"><el-checkbox :model-value="selectedIds.includes(item.id)" :aria-label="`选择 ${item.recipient}`" @change="checked => selectMobile(item, checked)" /><strong>{{ item.recipient }}</strong></div><dl><div><dt>取信主邮箱</dt><dd>{{ item.mailboxEmail }}</dd></div><div><dt>平台</dt><dd>{{ item.platformName || '全部平台' }}</dd></div><div><dt>有效期</dt><dd :class="{ expired: isExpired(item) }">{{ displayExpiry(item.expiresAt) }}</dd></div><div><dt>页面 / JSON</dt><dd>{{ item.pageVisits || 0 }} / {{ item.jsonVisits || 0 }}</dd></div></dl><div class="card-actions"><el-button type="primary" plain @click="copy(item.pageUrl)">复制链接</el-button><el-button @click="openPage(item.pageUrl)">打开</el-button><el-dropdown @command="command => linkAction(command, item)"><el-button>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="json">复制 JSON 地址</el-dropdown-item><el-dropdown-item command="expiry">修改有效期</el-dropdown-item><el-dropdown-item command="platform">修改平台</el-dropdown-item><el-dropdown-item command="delete" divided>删除链接</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></article></div>
    </div>
    <el-pagination v-if="total" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" :page-sizes="[20, 100, 250, 500, 750]" layout="total, prev, pager, next, sizes" @current-change="refresh" @size-change="search" />

    <el-dialog v-model="showCreate" title="生成子邮箱收件链接" width="min(680px, calc(100vw - 28px))" :close-on-click-modal="!createBusy" :close-on-press-escape="!createBusy" :show-close="!createBusy">
      <el-form label-position="top" :disabled="createBusy" @submit.prevent="create">
        <el-form-item label="实际取信的主邮箱"><el-select v-model="createForm.mailboxId" filterable remote :remote-method="findMailboxes" :loading="mailboxesLoading" placeholder="搜索主邮箱地址" style="width:100%"><el-option v-for="mailbox in mailboxOptions" :key="mailbox.id" :value="mailbox.id" :label="mailbox.email" :disabled="!mailbox.enabled" /></el-select></el-form-item>
        <el-form-item label="平台限制"><el-select v-model="createForm.platformId" clearable placeholder="全部平台（不限制发件人）" style="width:100%"><el-option v-for="platform in platforms" :key="platform.id" :value="platform.id" :label="platform.name" /></el-select></el-form-item>
        <el-form-item label="子邮箱完整地址"><el-input v-model="createForm.text" type="textarea" :rows="8" placeholder="a1@icloud.com&#10;a2@icloud.com&#10;a3@example.com" /><div class="form-help">可使用换行、空格、逗号或分号分隔。支持跨域子地址，其邮件须已转发到所选主邮箱并保留原始 To/Cc；每个链接只读取该主邮箱内对应子地址的邮件。已存在的地址复用原链接和原期限。</div></el-form-item>
        <div class="import-options"><el-checkbox v-model="firstLineIsMailbox">TXT 首行为主邮箱</el-checkbox><p class="form-help">勾选后自动匹配或新增主邮箱，其余行作为子邮箱，子地址可与主邮箱不同域。多选文件时，首行须为同一个主邮箱。</p></div>
        <div class="import-row"><label class="file-button" :class="{ disabled: createBusy }"><input type="file" accept=".txt,text/plain" multiple @change="appendFiles" :disabled="createBusy" />{{ importing ? '正在导入…' : '从 TXT 追加地址' }}</label><span>去重后 {{ parsedRecipients.length }} 个地址 / 最多 10000 个</span></div>
        <el-alert v-if="importSummary" :title="importSummary" type="info" :closable="false" />
        <el-form-item label="新链接有效期"><el-select v-model="createForm.expiryMode" style="width:100%"><el-option label="长期有效" value="never" /><el-option v-for="days in [1, 3, 7, 15, 30]" :key="days" :label="`${days} 天`" :value="String(days)" /><el-option label="指定日期时间" value="custom" /></el-select><el-date-picker v-if="createForm.expiryMode === 'custom'" v-model="createForm.expiry" type="datetime" placeholder="选择到期时间（本地时区）" style="width:100%;margin-top:10px" /></el-form-item>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
        <el-alert v-if="createdSummary" :title="createdSummary" type="success" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="createBusy" @click="showCreate = false">{{ createdSummary ? '关闭' : '取消' }}</el-button><el-button type="primary" :loading="saving" :disabled="importing || !parsedRecipients.length || !!createdSummary" @click="create">生成链接</el-button></template>
    </el-dialog>
    <el-dialog v-model="showBatch" title="批量修改所选链接" width="min(500px, calc(100vw - 28px))" :close-on-click-modal="!batchSaving" :close-on-press-escape="!batchSaving" :show-close="!batchSaving">
      <p class="form-help">本次操作已固定 {{ batchIds.length }} 个链接 ID。列表新增或选择变化不会加入本次操作。</p>
      <el-form label-position="top"><el-form-item label="操作"><el-select v-model="batchForm.action" style="width:100%" :disabled="batchSaving"><el-option label="设置平台" value="platform" /><el-option label="设置有效期" value="expiry" /><el-option label="删除链接" value="delete" /></el-select></el-form-item><el-form-item v-if="batchForm.action === 'platform'" label="目标平台"><el-select v-model="batchForm.platformId" clearable placeholder="清空表示不限平台" style="width:100%"><el-option v-for="platform in platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select></el-form-item><template v-if="batchForm.action === 'expiry'"><el-form-item label="新有效期"><el-select v-model="batchForm.expiryMode" style="width:100%"><el-option label="长期有效" value="never" /><el-option v-for="days in [1, 3, 7, 15, 30]" :key="days" :label="`${days} 天`" :value="String(days)" /><el-option label="指定日期时间" value="custom" /></el-select><el-date-picker v-if="batchForm.expiryMode === 'custom'" v-model="batchForm.expiry" type="datetime" style="width:100%;margin-top:10px" /></el-form-item></template></el-form>
      <el-alert v-if="batchForm.action === 'delete'" title="删除后，这些链接的收件页和 JSON 均会失效，邮件保留。此操作无法恢复原链接。" type="warning" :closable="false" /><el-alert v-if="batchError" :title="batchError" type="error" :closable="false" />
      <template #footer><el-button :disabled="batchSaving" @click="showBatch = false">取消</el-button><el-button :type="batchForm.action === 'delete' ? 'danger' : 'primary'" :loading="batchSaving" @click="submitBatch">{{ batchForm.action === 'delete' ? '确认删除所选链接' : '确认修改' }}</el-button></template>
    </el-dialog>
    <PlatformRules ref="platformRef" @changed="loadPlatforms(true)" />

    <el-dialog v-model="showExpiry" title="修改有效期" width="min(480px, calc(100vw - 28px))" :close-on-click-modal="!saving">
      <p class="expiry-address">{{ expiryItem?.recipient }}</p><el-checkbox v-model="expiryNever">长期有效</el-checkbox><el-date-picker v-if="!expiryNever" v-model="expiryDate" type="datetime" placeholder="选择到期时间（本地时区）" style="width:100%;margin-top:16px" /><p class="form-help">过去时间会立即使链接过期；改为未来时间或长期有效可恢复访问。</p><el-alert v-if="formError" :title="formError" type="error" :closable="false" />
      <template #footer><el-button :disabled="saving" @click="showExpiry = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveExpiry">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest, downloadFeatureExport } from '@/request/features.js'
import { useFeatureQuery } from '@/composables/use-feature-query.js'
import { copyText } from '@/utils/copy-text.js'
import { useAccountStore } from '@/store/account.js'
import { normalizeMailboxEmail } from '../mailboxes/batch-mailboxes.js'
import { parseLinkTxtFiles, resolveTxtMailbox } from './txt-import.js'
import './features.css'
import PlatformRules from './platform-rules.vue'

const route = useRoute()
const accountStore = useAccountStore()
const query = reactive({ mailboxId: String(route.query.mailboxId || ''), q: '', platformId: '', page: 1, pageSize: 20 })
const { items, total, loading, error, refresh } = useFeatureQuery(signal => adminFeatureRequest('/admin/links', { query, signal }))
const mailboxOptions = ref([]), capabilities = ref(null), mailboxesLoading = ref(false)
const tableRef = ref(null), selectedIds = ref([]), platforms = ref([]), platformRef = ref(null)
const showBatch = ref(false), batchSaving = ref(false), batchError = ref(''), batchIds = ref([])
const batchForm = reactive({ action: 'expiry', platformId: '', expiryMode: 'never', expiry: null })
let mailboxController, mailboxSequence = 0
async function findMailboxes(q = '') {
  const sequence = ++mailboxSequence
  mailboxController?.abort(); mailboxController = new AbortController(); mailboxesLoading.value = true
  try {
    const result = await adminFeatureRequest('/admin/mailboxes', { query: { q, page: 1, pageSize: 50 }, signal: mailboxController.signal })
    if (sequence !== mailboxSequence) return
    const selected = mailboxOptions.value.filter(item => item.id === query.mailboxId || item.id === createForm.mailboxId)
    mailboxOptions.value = [...new Map([...selected, ...result.items].map(item => [item.id, item])).values()]
    capabilities.value = result.capabilities
  } catch (cause) { if (cause.name !== 'AbortError') ElMessage.error(cause.message) } finally { if (sequence === mailboxSequence) mailboxesLoading.value = false }
}
const showCreate = ref(false), saving = ref(false), formError = ref(''), createdSummary = ref('')
const firstLineIsMailbox = ref(false), importing = ref(false), importSummary = ref('')
const createBusy = computed(() => saving.value || importing.value)
let importSequence = 0, importController
const exporting = ref(false)
const createForm = reactive({ mailboxId: query.mailboxId, platformId: '', text: '', expiryMode: 'never', expiry: null })
const parsedRecipients = computed(() => [...new Set(createForm.text.replace(/^\uFEFF/, '').split(/[\s,，;；]+/).map(address => normalizeMailboxEmail(address) || address.trim().toLowerCase()).filter(Boolean))])
const showExpiry = ref(false), expiryItem = ref(null), expiryNever = ref(true), expiryDate = ref(null)
function search() { query.page = 1; refresh() }
function displayExpiry(value) { return value ? new Date(value).toLocaleString() : '长期有效' }
function isExpired(item) { return item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now() }
function openCreate() {
  importSequence++
  Object.assign(createForm, { mailboxId: query.mailboxId, platformId: query.platformId === 'p0' ? '' : query.platformId, text: '', expiryMode: 'never', expiry: null })
  firstLineIsMailbox.value = false; importSummary.value = ''
  formError.value = ''; createdSummary.value = ''; showCreate.value = true; findMailboxes()
}
async function appendFiles(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  if (createBusy.value || !files.length) return
  if (files.length > 20 || files.reduce((size, file) => size + file.size, 0) > 24 * 1024 * 1024) { formError.value = '一次最多选择 20 个 TXT，总大小不超过 24 MiB'; return }
  const sequence = ++importSequence, useFirstLine = firstLineIsMailbox.value
  importController = new AbortController()
  const request = (path, options = {}) => adminFeatureRequest(path, { ...options, signal: importController.signal })
  importing.value = true; formError.value = ''; importSummary.value = ''
  try {
    const texts = await Promise.all(files.map(file => file.text().catch(() => { throw new Error('文件读取失败，请重新选择') })))
    if (sequence !== importSequence) return
    const parsed = parseLinkTxtFiles(texts, useFirstLine)
    const text = `${createForm.text ? `${createForm.text}\n` : ''}${parsed.text}`
    if (useFirstLine) {
      // Validate the combined list before a missing main mailbox can be created.
      parseLinkTxtFiles([`${parsed.mailboxEmail}\n${text}`], true)
      if (createForm.text.trim() && createForm.mailboxId) {
        const selected = mailboxOptions.value.find(item => item.id === createForm.mailboxId) || await request(`/admin/mailboxes/${encodeURIComponent(createForm.mailboxId)}`)
        if (normalizeMailboxEmail(selected.email) !== parsed.mailboxEmail) throw new Error('当前子邮箱属于另一个主邮箱，请先清空子邮箱名单，再导入新主邮箱的 TXT')
      }
      const { mailbox, created } = await resolveTxtMailbox(parsed.mailboxEmail, request)
      if (sequence !== importSequence) return
      mailboxOptions.value = [...new Map([...mailboxOptions.value, mailbox].map(item => [item.id, item])).values()]
      createForm.mailboxId = mailbox.id
      accountStore.listRevision++
      importSummary.value = `已${created ? '新增' : '匹配'}主邮箱 ${mailbox.email}，首行未加入子邮箱名单。`
    }
    createForm.text = text
    createdSummary.value = ''
  } catch (cause) { if (sequence === importSequence && cause.name !== 'AbortError') formError.value = cause.message }
  finally { if (sequence === importSequence) importing.value = false }
}
function expiresAt(mode, date) {
  if (mode === 'never') return null
  if (mode !== 'custom') return new Date(Date.now() + Number(mode) * 86400000).toISOString()
  if (!date || !Number.isFinite(new Date(date).getTime())) throw new Error('请选择有效的到期时间')
  return new Date(date).toISOString()
}
async function create() {
  if (createBusy.value) return
  formError.value = ''; createdSummary.value = ''
  if (!createForm.mailboxId) { formError.value = '请选择实际取信的主邮箱'; return }
  if (!parsedRecipients.value.length || parsedRecipients.value.length > 10000) { formError.value = '请填写 1～10000 个完整子邮箱地址'; return }
  const invalid = parsedRecipients.value.find(address => !/^[^\s@]+@[^\s@]+$/.test(address))
  if (invalid) { formError.value = `不是完整邮箱地址：${invalid}`; return }
  try {
    const data = { mailboxId: createForm.mailboxId, platformId: createForm.platformId || null, recipients: parsedRecipients.value, expiresAt: expiresAt(createForm.expiryMode, createForm.expiry) }
    saving.value = true
    const result = await adminFeatureRequest('/admin/links', { method: 'POST', data })
    createdSummary.value = `已生成 ${result.created} 个新链接，复用 ${result.reused} 个已有链接。`
    query.mailboxId = createForm.mailboxId; query.page = 1; await refresh()
  } catch (cause) { formError.value = cause.message } finally { saving.value = false }
}
async function copy(value) {
  try { await copyText(value); ElMessage.success('已复制') } catch (cause) { ElMessage.error(cause.message) }
}
async function exportLinks() {
  if (exporting.value) return
  exporting.value = true
  try {
    await downloadFeatureExport('/admin/links/export', { mailboxId: query.mailboxId, platformId: query.platformId, q: query.q })
    ElMessage.success('完整导出已下载')
  } catch (cause) { ElMessage.error(cause.message) } finally { exporting.value = false }
}
function openPage(url) { window.open(url, '_blank', 'noopener,noreferrer') }
async function linkAction(command, item) {
  if (command === 'open') return openPage(item.pageUrl)
  if (command === 'json') return copy(item.jsonUrl)
  if (command === 'platform') { openBatch([item.id]); batchForm.action = 'platform'; batchForm.platformId = item.platformId || ''; return }
  if (command === 'expiry') { expiryItem.value = item; expiryNever.value = !item.expiresAt; expiryDate.value = item.expiresAt ? new Date(item.expiresAt) : null; formError.value = ''; showExpiry.value = true; return }
  try {
    await ElMessageBox.confirm(`删除 ${item.recipient} 的链接后，页面和 JSON 都将失效，邮件会保留。确认删除？`, '删除收件链接', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await adminFeatureRequest(`/admin/links/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await refresh()
  } catch (cause) { if (cause instanceof Error) ElMessage.error(cause.message) }
}
async function saveExpiry() {
  if (saving.value) return
  formError.value = ''
  try {
    const data = { revision: expiryItem.value.revision, expiresAt: expiresAt(expiryNever.value ? 'never' : 'custom', expiryDate.value) }
    saving.value = true
    await adminFeatureRequest(`/admin/links/${encodeURIComponent(expiryItem.value.id)}`, { method: 'PUT', data })
    showExpiry.value = false; await refresh()
  } catch (cause) { formError.value = cause.message } finally { saving.value = false }
}
watch(() => route.query.mailboxId, value => { query.mailboxId = String(value || ''); search() })
watch(() => [query.mailboxId, query.platformId, query.q, query.page, query.pageSize], clearSelection)
watch(items, clearSelection)
onBeforeUnmount(() => { mailboxSequence++; mailboxController?.abort(); importSequence++; importController?.abort() })
async function initialize() {
  await findMailboxes()
  if (query.mailboxId && !mailboxOptions.value.some(item => item.id === query.mailboxId)) {
    try { const item = await adminFeatureRequest(`/admin/mailboxes/${encodeURIComponent(query.mailboxId)}`); mailboxOptions.value.unshift(item) } catch { /* The link list reports an invalid source filter. */ }
  }
}
async function loadPlatforms(refreshLinks = false) {
  try { platforms.value = (await adminFeatureRequest('/admin/platforms')).items; if (refreshLinks) await refresh() }
  catch (cause) { ElMessage.error(cause.message) }
}
function onSelection(rows) { selectedIds.value = rows.map(row => row.id) }
function clearSelection() { selectedIds.value = []; tableRef.value?.clearSelection() }
function selectMobile(item, checked) {
  selectedIds.value = checked ? [...new Set([...selectedIds.value, item.id])] : selectedIds.value.filter(id => id !== item.id)
  tableRef.value?.toggleRowSelection(item, checked)
}
function openBatch(ids = selectedIds.value) {
  if (!ids.length) return
  batchIds.value = [...ids]; batchError.value = ''; Object.assign(batchForm, { action: 'expiry', platformId: '', expiryMode: 'never', expiry: null }); showBatch.value = true
}
async function submitBatch() {
  if (batchSaving.value) return
  batchError.value = ''
  try {
    const value = batchForm.action === 'expiry' ? expiresAt(batchForm.expiryMode, batchForm.expiry) : batchForm.action === 'platform' ? batchForm.platformId || null : null
    batchSaving.value = true
    await adminFeatureRequest('/admin/links/batch', { method: 'POST', data: { ids: batchIds.value, action: batchForm.action, value } })
    showBatch.value = false; clearSelection(); await refresh(); ElMessage.success('批量操作已完成')
  } catch (cause) { batchError.value = cause.message } finally { batchSaving.value = false }
}
initialize(); loadPlatforms(); refresh()
</script>

<style scoped>
.table-actions { display: flex; gap: 14px; align-items: center; }
.expired { color: var(--el-color-danger); }
.import-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: -5px 0 22px; color: var(--el-text-color-secondary); font-size: 12px; }
.import-options { margin: -6px 0 16px; }
.import-options .form-help { margin: 0; }
.file-button { position: relative; display: inline-flex; border: 1px solid var(--el-border-color); padding: 7px 12px; border-radius: 5px; cursor: pointer; color: var(--el-color-primary); }
.file-button.disabled { opacity: .6; cursor: not-allowed; }
.file-button input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.expiry-address { overflow-wrap: anywhere; }
</style>
