<template>
  <section class="feature-page cards-page">
    <header class="page-heading">
      <div><h1>邮箱卡密管理</h1><p>一个兑换码绑定一个主邮箱，成功兑换后核销。重新生成不会改变已交付链接的有效期。</p></div>
      <div class="heading-actions"><el-button :disabled="!redeemUrl" @click="copy(redeemUrl)">复制兑换页地址</el-button><el-button type="primary" :disabled="!redeemUrl" @click="openRedeem">打开兑换页</el-button></div>
    </header>
    <el-alert v-if="configError" :title="configError" type="warning" :closable="false"><el-button text :loading="configLoading" @click="loadConfig()">重试读取兑换地址</el-button></el-alert>
    <el-tabs v-model="activeTab" @tab-change="tabChanged">
      <el-tab-pane label="兑换码" name="cards">
        <div class="status-grid"><div v-for="state in states" :key="state.value" class="status-box"><span>{{ state.label }}</span><strong>{{ stats[state.value] || 0 }}</strong></div></div>
        <div class="toolbar">
          <el-select v-model="searchMode" class="search-mode" :disabled="mutationBusy" @change="search"><el-option label="主邮箱搜索" value="email" /><el-option label="完整兑换码" value="code" /></el-select>
          <el-input v-model="query.q" :maxlength="searchMode === 'code' ? 128 : 320" clearable :placeholder="searchMode === 'code' ? '输入完整兑换码精确查询' : '搜索主邮箱地址'" :disabled="mutationBusy" @keyup.enter="search" @clear="search" />
          <el-select v-model="query.status" class="status-filter" :disabled="mutationBusy" @change="search"><el-option label="全部状态" value="" /><el-option v-for="state in states" :key="state.value" :label="state.label" :value="state.value" /></el-select>
          <el-button :disabled="mutationBusy" @click="search">查询</el-button><el-button :loading="loading" :disabled="mutationBusy" @click="refreshCards">刷新</el-button>
        </div>
        <div class="selection-bar"><span>已选择 {{ selection.length }} 个主邮箱</span><div><el-button :loading="mutationBusy && busyId === 'generate'" :disabled="!selection.length || mutationBusy || loading" @click="generate(selection)">批量初次生成</el-button><el-button :disabled="!selectedUsable.length || mutationBusy || loading" @click="copyCodes(selectedUsable)">复制可用码</el-button><el-button :loading="exporting" :disabled="!selectedUsable.length || mutationBusy || loading" @click="exportCodes(selectedUsable)">导出可用码 TXT</el-button></div></div>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"><el-button text @click="refreshCards">重新加载</el-button></el-alert>
        <div v-loading="loading" class="list-region">
          <el-table ref="tableRef" :data="items" row-key="mailboxId" :empty-text="loading || error ? ' ' : '没有符合条件的主邮箱'" @selection-change="selection = $event">
            <el-table-column type="selection" width="44" :selectable="selectable" />
            <el-table-column label="主邮箱" min-width="210" show-overflow-tooltip><template #default="{ row }"><strong>{{ row.mailboxEmail }}</strong><div v-if="!row.mailboxEnabled" class="muted">主邮箱已停用</div></template></el-table-column>
            <el-table-column label="子邮箱 / 链接" width="120"><template #default="{ row }">{{ row.childCount || 0 }} / {{ row.linkCount || 0 }}</template></el-table-column>
            <el-table-column label="当前兑换码" min-width="290"><template #default="{ row }"><code class="card-code">{{ row.card?.code || '尚未生成' }}</code></template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="cardStatusType(row.card?.status)">{{ cardStatusLabel(row.card?.status) }}</el-tag></template></el-table-column>
            <el-table-column label="生成 / 核销时间" min-width="184"><template #default="{ row }"><div>{{ redemptionTime(row.card?.createdAt) }}</div><div class="muted">{{ redemptionTime(row.card?.redeemedAt) }}</div></template></el-table-column>
            <el-table-column label="操作" min-width="238" :fixed="isDesktop ? 'right' : false"><template #default="{ row }"><div class="row-actions">
              <el-button v-if="!row.card" link type="primary" :loading="busyId === row.mailboxId" :disabled="mutationBusy || !row.mailboxEnabled" @click="generate([row], row.mailboxId)">初次生成</el-button>
              <template v-else><el-button link type="primary" :disabled="mutationBusy" @click="copy(row.card.code)">复制</el-button><el-button v-if="['unused', 'disabled'].includes(row.card.status)" link :type="row.card.enabled ? 'warning' : 'success'" :loading="busyId === row.card.id" :disabled="mutationBusy" @click="toggleCard(row)">{{ row.card.enabled ? '停用' : '恢复' }}</el-button><el-button link type="primary" :disabled="mutationBusy || !row.mailboxEnabled" @click="regenerate(row)">重新生成</el-button><el-button link :disabled="mutationBusy" @click="openHistory(row)">历史</el-button></template>
              <el-button link :disabled="mutationBusy" @click="ordersForMailbox(row)">订单</el-button>
            </div></template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="total" v-model:current-page="query.page" v-model:page-size="query.pageSize" :disabled="mutationBusy" :total="total" :page-sizes="[20, 50, 100]" layout="total, prev, pager, next, sizes" @current-change="refreshCards" @size-change="search" />
      </el-tab-pane>
      <el-tab-pane label="兑换订单" name="orders">
        <div class="toolbar"><el-input v-model="orderQuery.q" clearable placeholder="搜索订单号或主邮箱" @keyup.enter="searchOrders" @clear="searchOrders" /><el-select v-model="orderQuery.status" class="status-filter" @change="searchOrders"><el-option label="全部订单" value="" /><el-option label="全部成功" value="success" /><el-option label="部分成功" value="partial" /><el-option label="全部失败" value="failed" /></el-select><el-button @click="searchOrders">查询</el-button><el-button :loading="ordersLoading" @click="loadOrders">刷新</el-button><el-tag v-if="orderQuery.mailboxId" closable @close="clearMailboxFilter">仅当前主邮箱</el-tag></div>
        <el-alert v-if="ordersError" :title="ordersError" type="error" :closable="false"><el-button text @click="loadOrders">重试</el-button></el-alert>
        <div v-loading="ordersLoading" class="list-region"><el-table :data="orders" row-key="orderNo" :empty-text="ordersLoading || ordersError ? ' ' : '暂无兑换订单'">
          <el-table-column prop="orderNo" label="订单号" min-width="220" show-overflow-tooltip />
          <el-table-column label="兑换时间" min-width="180"><template #default="{ row }">{{ redemptionTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="结果" width="110"><template #default="{ row }"><el-tag :type="orderStatusType(row.status)">{{ orderStatusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="成功 / 失败" width="118"><template #default="{ row }">{{ row.successCount || 0 }} / {{ row.failureCount || 0 }}</template></el-table-column>
          <el-table-column label="交付" min-width="140"><template #default="{ row }">{{ row.file ? `${row.batch ? 'ZIP' : 'TXT'} · ${row.childCount || 0} 个子邮箱` : '无交付文件' }}</template></el-table-column>
          <el-table-column label="操作" width="150"><template #default="{ row }"><el-button link type="primary" @click="openOrder(row)">详情</el-button><el-button link type="primary" :loading="downloadId === row.orderNo" :disabled="!row.file || !!downloadId" @click="downloadOrder(row)">下载</el-button></template></el-table-column>
        </el-table></div>
        <el-pagination v-if="ordersTotal" v-model:current-page="orderQuery.page" v-model:page-size="orderQuery.pageSize" :total="ordersTotal" :page-sizes="[20, 50, 100]" layout="total, prev, pager, next, sizes" @current-change="loadOrders" @size-change="searchOrders" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="generatedVisible" title="本次兑换码结果" width="min(850px, calc(100vw - 28px))">
      <p class="dialog-help">共 {{ generated.length }} 个主邮箱。初次生成保留已有兑换码和核销状态；重新生成后原码永久作废。</p>
      <el-table :data="generated" row-key="mailboxId" max-height="430"><el-table-column prop="mailboxEmail" label="主邮箱" min-width="210" /><el-table-column label="兑换码" min-width="300"><template #default="{ row }"><code class="card-code">{{ row.card?.code }}</code></template></el-table-column><el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="cardStatusType(row.card?.status)">{{ cardStatusLabel(row.card?.status) }}</el-tag></template></el-table-column></el-table>
      <template #footer><el-button @click="generatedVisible = false">关闭</el-button><el-button :disabled="!generatedUsable.length" @click="copyCodes(generatedUsable)">复制可用码</el-button><el-button type="primary" :loading="exporting" :disabled="!generatedUsable.length" @click="exportCodes(generatedUsable)">下载可用码 TXT</el-button></template>
    </el-dialog>
    <el-dialog v-model="historyVisible" :title="`${historyMailbox?.mailboxEmail || ''} · 兑换码历史`" width="min(1000px, calc(100vw - 28px))">
      <el-alert v-if="historyError" :title="historyError" type="error" :closable="false"><el-button text @click="loadHistory()">重试</el-button></el-alert>
      <div v-loading="historyLoading"><el-table :data="history?.items || []" row-key="id" max-height="460"><el-table-column label="兑换码" min-width="300"><template #default="{ row }"><code class="card-code">{{ row.code }}</code></template></el-table-column><el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="cardStatusType(row.status)">{{ cardStatusLabel(row.status) }}</el-tag><div v-if="row.isCurrent" class="muted">当前码</div></template></el-table-column><el-table-column label="生成时间" min-width="180"><template #default="{ row }">{{ redemptionTime(row.createdAt) }}</template></el-table-column><el-table-column label="核销时间" min-width="180"><template #default="{ row }">{{ redemptionTime(row.redeemedAt) }}</template></el-table-column><el-table-column label="作废时间" min-width="180"><template #default="{ row }">{{ redemptionTime(row.revokedAt) }}</template></el-table-column></el-table></div>
    </el-dialog>
    <el-dialog v-model="orderVisible" title="兑换订单详情" width="min(1050px, calc(100vw - 28px))">
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false"><el-button text @click="loadDetail()">重试</el-button></el-alert><div v-loading="detailLoading" class="detail-region"><RedemptionOrder v-if="detail" :order="detail" :downloading="downloadId === detail.orderNo" :download-disabled="!!downloadId" @download="downloadOrder(detail)" /></div>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest, downloadFeatureFile } from '@/request/features.js'
import { useFeatureQuery } from '@/composables/use-feature-query.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { copyText } from '@/utils/copy-text.js'
import { cardStatusLabel, cardStatusType, orderStatusLabel, orderStatusType, redemptionTime, createRedemptionKey } from '@/utils/redemption.js'
import RedemptionOrder from '@/components/redemption-order/index.vue'
import '@/views/links/features.css'

const activeTab = ref('cards'), isDesktop = useMediaQuery('(min-width: 768px)')
const states = [{ value: 'unissued', label: '未生成' }, { value: 'unused', label: '未核销' }, { value: 'redeemed', label: '已核销' }, { value: 'disabled', label: '已停用' }]
const stats = ref({}), searchMode = ref('email'), query = ref({ q: '', status: '', page: 1, pageSize: 50 })
const tableRef = ref(null), selection = ref([]), busyId = ref(''), mutationBusy = ref(false), exporting = ref(false)
const { items, total, loading, error, refresh: fetchCards } = useFeatureQuery(signal => {
  const filters = { status: query.value.status, page: query.value.page, pageSize: query.value.pageSize }
  return searchMode.value === 'code' && query.value.q.trim()
    ? adminFeatureRequest('/admin/cards/search', { method: 'POST', data: { ...filters, code: query.value.q.trim() }, signal })
    : adminFeatureRequest('/admin/cards', { query: { ...filters, q: searchMode.value === 'email' ? query.value.q.trim() : '' }, signal })
})
const selectedUsable = computed(() => selection.value.filter(usable))
function usable(row) { return row.card?.status === 'unused' && row.card.enabled }
function selectable(row) { return !mutationBusy.value && row.mailboxEnabled }
async function refreshCards() {
  tableRef.value?.clearSelection(); selection.value = []
  const result = await fetchCards()
  if (result) stats.value = result.stats || {}
}
function search() { query.value.page = 1; refreshCards() }
const { data: config, loading: configLoading, error: configError, refresh: loadConfig } = useFeatureResource(signal => adminFeatureRequest('/admin/cards/config', { signal }))
const redeemUrl = computed(() => {
  try { const url = new URL(config.value?.redeemUrl); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' }
})
function openRedeem() { if (redeemUrl.value) window.open(redeemUrl.value, '_blank', 'noopener,noreferrer') }
async function copy(value) {
  if (!value) return
  try { await copyText(value); ElMessage.success('已复制') } catch (cause) { ElMessage.error(cause.message) }
}
function copyCodes(rows) { return copy(rows.filter(usable).map(row => row.card.code).join('\r\n')) }
async function exportCodes(rows) {
  if (exporting.value) return
  const mailboxIds = rows.filter(usable).map(row => row.mailboxId)
  if (!mailboxIds.length) return
  exporting.value = true
  try { await downloadFeatureFile('/admin/cards/export', { mailboxIds }, { filename: `mailbox-codes-${Date.now()}.txt` }) }
  catch (cause) { ElMessage.error(cause.message || '导出失败，请重试') }
  finally { exporting.value = false }
}
const generatedVisible = ref(false), generated = ref([])
const generatedUsable = computed(() => generated.value.filter(usable))
async function generate(rows, id = 'generate') {
  if (mutationBusy.value || !rows.length) return
  mutationBusy.value = true; busyId.value = id
  try {
    const result = await adminFeatureRequest('/admin/cards', { method: 'POST', data: { mailboxIds: rows.map(row => row.mailboxId) } })
    generated.value = result.items || []; generatedVisible.value = true
    await refreshCards()
  } catch (cause) { ElMessage.error(cause.message || '生成失败，请重试') }
  finally { mutationBusy.value = false; busyId.value = '' }
}
async function toggleCard(row) {
  if (mutationBusy.value) return
  const enabled = !row.card.enabled
  try { await ElMessageBox.confirm(enabled ? '恢复后，此兑换码可继续兑换一次。' : '停用后此码将不能兑换，已交付链接继续按原有效期使用。', enabled ? '恢复兑换码' : '停用兑换码', { type: 'warning', confirmButtonText: enabled ? '恢复' : '停用', cancelButtonText: '取消' }) } catch { return }
  if (mutationBusy.value) return
  mutationBusy.value = true; busyId.value = row.card.id
  try { await adminFeatureRequest(`/admin/cards/${encodeURIComponent(row.card.id)}`, { method: 'PUT', data: { enabled, revision: row.card.revision } }); await refreshCards(); ElMessage.success(enabled ? '已恢复' : '已停用') }
  catch (cause) { ElMessage.error(cause.message) }
  finally { mutationBusy.value = false; busyId.value = '' }
}
const regenerationKeys = new Map()
async function regenerate(row) {
  if (mutationBusy.value) return
  try { await ElMessageBox.confirm(`原码将永久作废，新码仍绑定 ${row.mailboxEmail}，可兑换一次。原来交付的链接按原有效期继续使用。`, '重新生成兑换码', { type: 'warning', confirmButtonText: '生成新码', cancelButtonText: '取消' }) } catch { return }
  if (mutationBusy.value) return
  const attemptId = `${row.card.id}:${row.card.revision}`
  if (!regenerationKeys.has(attemptId)) regenerationKeys.set(attemptId, createRedemptionKey())
  mutationBusy.value = true; busyId.value = row.card.id
  try {
    const result = await adminFeatureRequest(`/admin/cards/${encodeURIComponent(row.card.id)}/regenerate`, { method: 'POST', data: { revision: row.card.revision, requestKey: regenerationKeys.get(attemptId) } })
    generated.value = [{ ...row, card: result.card }]; generatedVisible.value = true; regenerationKeys.delete(attemptId)
    await refreshCards()
  } catch (cause) { ElMessage.error(cause.message || '结果尚未确认，可再次点击重新生成重试本次操作') }
  finally { mutationBusy.value = false; busyId.value = '' }
}
const historyVisible = ref(false), historyMailbox = ref(null)
const { data: history, loading: historyLoading, error: historyError, refresh: loadHistory } = useFeatureResource(signal => adminFeatureRequest(`/admin/cards/${encodeURIComponent(historyMailbox.value.mailboxId)}/history`, { signal }))
function openHistory(row) { historyMailbox.value = row; history.value = null; historyVisible.value = true; loadHistory() }
const orderQuery = ref({ q: '', status: '', mailboxId: '', page: 1, pageSize: 20 })
const { items: orders, total: ordersTotal, loading: ordersLoading, error: ordersError, refresh: loadOrders } = useFeatureQuery(signal => adminFeatureRequest('/admin/redemption-orders', { query: { ...orderQuery.value }, signal }))
function searchOrders() { orderQuery.value.page = 1; loadOrders() }
function tabChanged(tab) { if (tab === 'orders') loadOrders() }
function ordersForMailbox(row) { orderQuery.value.mailboxId = row.mailboxId; orderQuery.value.q = ''; orderQuery.value.page = 1; if (activeTab.value === 'orders') loadOrders(); else activeTab.value = 'orders' }
function clearMailboxFilter() { orderQuery.value.mailboxId = ''; searchOrders() }
const orderVisible = ref(false), selectedOrderNo = ref(''), downloadId = ref('')
const { data: detail, loading: detailLoading, error: detailError, refresh: loadDetail } = useFeatureResource(signal => adminFeatureRequest(`/admin/redemption-orders/${encodeURIComponent(selectedOrderNo.value)}`, { signal }))
function openOrder(order) { selectedOrderNo.value = order.orderNo; detail.value = null; orderVisible.value = true; loadDetail() }
async function downloadOrder(order) {
  if (downloadId.value || !order.file) return
  downloadId.value = order.orderNo
  try { await downloadFeatureFile(`/admin/redemption-orders/${encodeURIComponent(order.orderNo)}/download`, {}, { filename: order.file.filename }) }
  catch (cause) { ElMessage.error(cause.message || '下载失败，请重试') }
  finally { downloadId.value = '' }
}
loadConfig(); refreshCards()
</script>

<style scoped>
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 3px 0 22px; }
.status-box { padding: 16px 18px; border: 1px solid var(--el-border-color-light); background: var(--el-bg-color); border-radius: 11px; }
.status-box span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.status-box strong { display: block; font-size: 26px; margin-top: 7px; font-weight: 600; }
.cards-page .toolbar .search-mode { width: 150px; }
.cards-page .toolbar .status-filter { width: 150px; }
.selection-bar { display: flex; gap: 12px; justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: 16px; color: var(--el-text-color-secondary); font-size: 13px; }
.selection-bar > div { display: flex; gap: 8px; flex-wrap: wrap; }
.selection-bar .el-button + .el-button, .row-actions .el-button + .el-button { margin-left: 0; }
.row-actions { display: flex; flex-wrap: wrap; gap: 0 12px; }
.card-code { overflow-wrap: anywhere; user-select: all; font-size: 12px; line-height: 1.7; }
.muted, .dialog-help { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.detail-region { min-height: 160px; }
@media (max-width: 767px) { .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; } .status-box { padding: 13px; } .cards-page .toolbar .search-mode, .cards-page .toolbar .status-filter { width: 100%; } .selection-bar > div { width: 100%; } }
</style>
