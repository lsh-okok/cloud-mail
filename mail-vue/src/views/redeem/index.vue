<template>
  <main class="redeem-page">
    <div class="redeem-shell">
      <header class="public-heading"><p class="eyebrow">CLOUD MAIL</p><h1>邮箱兑换</h1><p>凭兑换码领取主邮箱下的全部子邮箱取码链接。</p></header>
      <el-tabs v-model="activeTab" @tab-change="tabChanged">
        <el-tab-pane label="兑换邮箱" name="redeem">
          <section class="public-card">
            <div class="section-heading"><div><h2>输入兑换码</h2><p>每个码可成功兑换一次。单码下载 TXT，批量按主邮箱分文件打包为 ZIP。</p></div><el-button :disabled="redeeming || fileLoading || attempt?.phase === 'uncertain'" :loading="fileLoading" @click="codeFileRef.click()">导入 TXT</el-button><input ref="codeFileRef" class="file-input" type="file" accept=".txt,text/plain" @change="importCodes" /></div>
            <el-input v-model="rawCodes" type="textarea" :rows="7" resize="vertical" placeholder="粘贴兑换码，每行一个，也可用空格、逗号或分号分隔" :disabled="redeeming || attempt?.phase === 'uncertain'" aria-label="兑换码" @input="inputChanged" />
            <div class="input-note"><span :class="{ invalid: parsedCodes.length > 100 }">去重后 {{ parsedCodes.length }} 个兑换码 / 每批最多 100 个</span><span>TXT 最大 256 KiB</span></div>
            <el-alert v-if="redeemError" :title="redeemError" type="error" show-icon :closable="false" />
            <div v-if="!attempt" class="submit-row"><el-button type="primary" :disabled="!parsedCodes.length || parsedCodes.length > 100 || fileLoading" @click="prepare()">准备兑换</el-button></div>
            <div v-if="attempt" class="credential-panel">
              <h3>{{ attempt.phase === 'complete' ? '本次查询凭证' : '先保存查询凭证' }}</h3>
              <p>请妥善保存，关闭页面后可凭它查询订单和重新下载。持有此凭证的人可以查看本次交付内容。</p>
              <el-input :model-value="attempt.key" type="password" show-password readonly aria-label="本次查询凭证" />
              <div class="credential-actions"><el-button :disabled="redeeming" @click="copyCredential(attempt.key, true)">复制凭证</el-button><el-button :disabled="redeeming" @click="saveCredential(attempt.key, currentAttemptOrder?.orderNo, true)">下载凭证 TXT</el-button><span v-if="savedCredential" class="saved-note">已保存</span></div>
              <div class="submit-row">
                <el-button v-if="attempt.phase !== 'complete'" type="primary" :loading="redeeming" :disabled="!savedCredential || fileLoading" @click="submit">{{ attempt.phase === 'uncertain' ? '重试本次兑换' : `确认兑换 ${attempt.codes.length} 个码` }}</el-button>
                <el-button v-if="attempt.phase === 'uncertain' || attempt.phase === 'complete'" :disabled="redeeming" @click="lookupAttempt">查询本次订单</el-button>
                <el-button :disabled="redeeming" @click="startNew">{{ attempt.phase === 'prepared' ? '重新填写' : '开始新的兑换' }}</el-button>
              </div>
            </div>
          </section>
          <section v-for="entry in receivedOrders" :key="entry.order.orderNo" class="public-card result-card">
            <RedemptionOrder :order="entry.order" :downloading="downloadingNo === entry.order.orderNo" :download-disabled="!!downloadingNo" @download="downloadOrder(entry)" />
            <div class="result-actions"><el-button @click="copyCredential(entry.queryKey)">复制查询凭证</el-button><el-button @click="saveCredential(entry.queryKey, entry.order.orderNo)">保存订单凭证</el-button><el-button v-if="entry.order.failureCount && entry.codes" :disabled="redeeming" @click="retryFailed(entry)">仅填写失败码重试</el-button></div>
          </section>
        </el-tab-pane>
        <el-tab-pane label="查询订单" name="query">
          <section class="public-card">
            <div class="section-heading"><div><h2>找回兑换结果</h2><p>填写保存的查询凭证即可查询；已取得订单号时也可一并填写。</p></div><el-button :disabled="querying" @click="credentialFileRef.click()">导入凭证 TXT</el-button><input ref="credentialFileRef" type="file" class="file-input" accept=".txt,text/plain" @change="importCredential" /></div>
            <el-form label-position="top" @submit.prevent="queryOrder">
              <el-form-item label="查询凭证"><el-input v-model="queryKey" type="password" show-password maxlength="128" autocomplete="off" placeholder="填写兑换前保存的查询凭证" :disabled="querying" @input="clearLookup" /></el-form-item>
              <el-form-item label="订单号（选填）"><el-input v-model="orderNo" maxlength="128" autocomplete="off" placeholder="未收到兑换响应时可留空" :disabled="querying" @input="clearLookup" /></el-form-item>
              <el-alert v-if="queryError" :title="queryError" type="error" show-icon :closable="false" />
              <el-button type="primary" native-type="submit" :loading="querying" :disabled="!queryKey.trim()">查询订单</el-button>
            </el-form>
          </section>
          <section v-if="queriedOrder" class="public-card result-card"><RedemptionOrder :order="queriedOrder.order" :downloading="downloadingNo === queriedOrder.order.orderNo" :download-disabled="!!downloadingNo" @download="downloadOrder(queriedOrder)" /><div class="result-actions"><el-button @click="saveCredential(queriedOrder.queryKey, queriedOrder.order.orderNo)">保存订单凭证</el-button></div></section>
        </el-tab-pane>
      </el-tabs>
      <footer>兑换码默认长期有效。取码链接按原有效期使用，查询和重新下载不会延长期限。</footer>
    </div>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { publicFeatureRequest, downloadFeatureFile } from '@/request/features.js'
import { parseRedemptionCodes, createRedemptionKey, saveRedemptionText } from '@/utils/redemption.js'
import { copyText } from '@/utils/copy-text.js'
import RedemptionOrder from '@/components/redemption-order/index.vue'

const route = useRoute(), router = useRouter()
const activeTab = ref(route.name === 'redemption-order-query' ? 'query' : 'redeem')
function tabChanged(tab) { router.replace({ name: tab === 'query' ? 'redemption-order-query' : 'redeem' }) }
watch(() => route.name, name => { activeTab.value = name === 'redemption-order-query' ? 'query' : 'redeem' })
const rawCodes = ref(''), parsedCodes = computed(() => parseRedemptionCodes(rawCodes.value))
const redeemError = ref(''), redeeming = ref(false), fileLoading = ref(false), codeFileRef = ref(null), credentialFileRef = ref(null)
const attempt = shallowRef(null), savedCredential = ref(false), receivedOrders = ref([])
const currentAttemptOrder = computed(() => receivedOrders.value.find(entry => entry.queryKey === attempt.value?.key)?.order)
let redeemController, queryController, downloadController, querySequence = 0, alive = true

function rememberOrder(order, key, codes) {
  const entry = { order, queryKey: key, ...(codes ? { codes: [...codes] } : {}) }
  const index = receivedOrders.value.findIndex(value => value.order.orderNo === order.orderNo)
  if (index < 0) receivedOrders.value.unshift(entry)
  else receivedOrders.value[index] = { ...receivedOrders.value[index], ...entry }
  return entry
}

function validateCodes(codes) {
  if (!codes.length || codes.length > 100) return '每次请输入 1～100 个不同兑换码'
  if (codes.some(code => new TextEncoder().encode(code).byteLength > 128)) return '存在过长的兑换码，请检查输入内容'
  return ''
}
function prepare(codes = parsedCodes.value) {
  if (redeeming.value) return
  redeemError.value = validateCodes(codes)
  if (redeemError.value) return
  try { attempt.value = { codes: [...codes], key: createRedemptionKey(), phase: 'prepared' }; savedCredential.value = false }
  catch { redeemError.value = '浏览器无法生成查询凭证，请更换浏览器后重试' }
}
function inputChanged() { if (!redeeming.value && attempt.value?.phase !== 'uncertain') { attempt.value = null; savedCredential.value = false; redeemError.value = '' } }
async function importCodes(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file || redeeming.value || attempt.value?.phase === 'uncertain') return
  if (!/\.txt$/i.test(file.name) || file.size > 256 * 1024) { redeemError.value = '请选择不超过 256 KiB 的 TXT 文件'; return }
  fileLoading.value = true; redeemError.value = ''
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '')
    if (!alive) return
    rawCodes.value = [rawCodes.value.trim(), text.trim()].filter(Boolean).join('\n'); inputChanged()
  } catch { if (alive) redeemError.value = '文件读取失败，请重新选择' }
  finally { if (alive) fileLoading.value = false }
}
async function copyCredential(key, markSaved = false) {
  try { await copyText(key); if (markSaved) savedCredential.value = true; ElMessage.success('查询凭证已复制，请妥善保存') }
  catch (cause) { ElMessage.error(cause.message) }
}
function saveCredential(key, number = '', markSaved = false) {
  const queryUrl = new URL(router.resolve({ name: 'redemption-order-query' }).href, window.location.origin).href
  const text = `${number ? `订单号: ${number}\r\n` : ''}查询凭证: ${key}\r\n查询页面: ${queryUrl}\r\n请妥善保存此凭证，持有者可以查询并下载本次兑换结果。\r\n`
  saveRedemptionText(text, `mailbox-order-${number || Date.now()}-credential.txt`)
  if (markSaved) savedCredential.value = true
}
async function submit() {
  if (redeeming.value || !attempt.value || !savedCredential.value || attempt.value.phase === 'complete') return
  const original = attempt.value
  redeemController?.abort(); redeemController = new AbortController()
  redeeming.value = true; redeemError.value = ''
  const timeout = setTimeout(() => redeemController.abort(), 60000)
  try {
    const order = await publicFeatureRequest('/redeem', { method: 'POST', data: { codes: original.codes, requestKey: original.key }, signal: redeemController.signal })
    if (!alive || attempt.value?.key !== original.key) return
    rememberOrder(order, original.key, original.codes)
    attempt.value = { ...original, phase: 'complete' }
  } catch (cause) {
    if (!alive) return
    attempt.value = { ...original, phase: 'uncertain' }
    redeemError.value = cause.name === 'AbortError' || !cause.status || cause.status >= 500
      ? '提交结果暂未确认。请重试本次兑换，或使用已保存的查询凭证查询订单。'
      : cause.message || '兑换失败，请稍后重试'
  } finally { clearTimeout(timeout); if (alive) redeeming.value = false }
}
async function startNew() {
  if (redeeming.value) return
  if (attempt.value?.phase === 'uncertain') {
    try { await ElMessageBox.confirm('本次兑换结果尚未确认，已保存的凭证仍可查询原订单。是否开始新一轮填写？', '保留原订单查询凭证', { confirmButtonText: '开始新一轮', cancelButtonText: '继续本次兑换', type: 'warning' }) } catch { return }
  }
  attempt.value = null; savedCredential.value = false; redeemError.value = ''; rawCodes.value = ''
}
function retryFailed(entry) {
  if (redeeming.value || !entry.codes) return
  if (attempt.value?.phase === 'uncertain') { ElMessage.warning('请先查询或重试尚未确认的兑换'); return }
  const failed = entry.order.items.filter(item => !item.ok).map(item => entry.codes[item.index]).filter(Boolean)
  rawCodes.value = failed.join('\n'); prepare(failed)
}
const queryKey = ref(''), orderNo = ref(''), queryError = ref(''), querying = ref(false), queriedOrder = shallowRef(null)
function clearLookup() { querySequence++; queryController?.abort(); querying.value = false; queriedOrder.value = null; queryError.value = '' }
async function queryOrder() {
  if (querying.value || !queryKey.value.trim()) return
  const credentials = { queryKey: queryKey.value.trim(), ...(orderNo.value.trim() ? { orderNo: orderNo.value.trim() } : {}) }
  const current = ++querySequence
  queryController?.abort(); queryController = new AbortController(); querying.value = true; queryError.value = ''; queriedOrder.value = null
  const timeout = setTimeout(() => queryController.abort(), 60000)
  try {
    const order = await publicFeatureRequest('/orders/query', { method: 'POST', data: credentials, signal: queryController.signal })
    if (alive && current === querySequence) {
      queriedOrder.value = { order, queryKey: credentials.queryKey }
      if (attempt.value?.key === credentials.queryKey) {
        rememberOrder(order, credentials.queryKey, attempt.value.codes)
        attempt.value = { ...attempt.value, phase: 'complete' }
        redeemError.value = ''
      }
    }
  } catch (cause) { if (alive && current === querySequence) queryError.value = cause.name === 'AbortError' ? '查询超时，请稍后重试' : cause.message || '查询失败，请重试' }
  finally { clearTimeout(timeout); if (alive && current === querySequence) querying.value = false }
}
function lookupAttempt() {
  if (!attempt.value || redeeming.value) return
  clearLookup(); queryKey.value = attempt.value.key; orderNo.value = currentAttemptOrder.value?.orderNo || ''; activeTab.value = 'query'; queryOrder()
}
async function importCredential(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file || querying.value) return
  if (!/\.txt$/i.test(file.name) || file.size > 16 * 1024) { queryError.value = '请选择保存的查询凭证 TXT 文件'; return }
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '')
    if (!alive) return
    const key = /(?:查询凭证|queryKey)\s*[:：]\s*([A-Za-z0-9_-]{43,128})/i.exec(text)?.[1]
    if (!key) { queryError.value = '文件中没有找到查询凭证，请手动填写'; return }
    clearLookup(); queryKey.value = key; orderNo.value = /(?:订单号|orderNo)\s*[:：]\s*([^\s]+)/i.exec(text)?.[1] || ''
  } catch { if (alive) queryError.value = '文件读取失败，请重试' }
}
const downloadingNo = ref('')
async function downloadOrder(entry) {
  if (downloadingNo.value || !entry.order.file) return
  downloadController = new AbortController(); downloadingNo.value = entry.order.orderNo
  try { await downloadFeatureFile('/orders/download', { orderNo: entry.order.orderNo, queryKey: entry.queryKey }, { admin: false, filename: entry.order.file.filename, signal: downloadController.signal }) }
  catch (cause) { if (alive) ElMessage.error(cause.message || '下载失败，请重试原订单') }
  finally { if (alive) downloadingNo.value = '' }
}
onBeforeUnmount(() => { alive = false; querySequence++; redeemController?.abort(); queryController?.abort(); downloadController?.abort() })
</script>

<style scoped>
.redeem-page { min-height: 100dvh; padding: 44px 24px 30px; box-sizing: border-box; background: var(--el-fill-color-lighter); color: var(--el-text-color-primary); }
.redeem-shell { max-width: 980px; margin: 0 auto; }
.public-heading { margin-bottom: 26px; }
.eyebrow { margin: 0 0 10px; font-size: 11px; letter-spacing: .18em; font-weight: 700; color: var(--el-color-primary); }
.public-heading h1 { margin: 0 0 10px; font-size: 29px; letter-spacing: -.025em; }
.public-heading > p:last-child { margin: 0; font-size: 14px; line-height: 1.8; color: var(--el-text-color-secondary); }
.public-card { margin: 10px 0 22px; padding: 25px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); min-width: 0; }
.section-heading { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.section-heading h2 { margin: 0 0 8px; font-size: 18px; }
.section-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.75; }
.section-heading > .el-button { flex-shrink: 0; }
.file-input { display: none; }
.input-note { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 10px 0 18px; color: var(--el-text-color-secondary); font-size: 12px; }
.invalid { color: var(--el-color-danger); }
.submit-row, .credential-actions, .result-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.submit-row { margin-top: 18px; }
.submit-row .el-button + .el-button, .credential-actions .el-button + .el-button, .result-actions .el-button + .el-button { margin-left: 0; }
.credential-panel { background: var(--el-fill-color-lighter); padding: 19px; border: 1px solid var(--el-border-color-light); border-radius: 10px; margin-top: 17px; }
.credential-panel h3 { margin: 0 0 8px; font-size: 15px; }
.credential-panel p { font-size: 12px; line-height: 1.8; color: var(--el-text-color-secondary); margin: 0 0 14px; }
.credential-actions { margin-top: 12px; }
.saved-note { color: var(--el-color-success); font-size: 12px; }
.public-card .el-alert { margin-bottom: 15px; }
.result-actions { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
footer { font-size: 12px; text-align: center; color: var(--el-text-color-secondary); line-height: 1.8; margin-top: 26px; }
@media (max-width: 600px) { .redeem-page { padding: 26px 14px; } .public-card { padding: 18px 15px; } .public-heading h1 { font-size: 25px; } .section-heading { gap: 10px; } .credential-panel { padding: 14px; } .credential-actions .el-button, .submit-row .el-button { max-width: 100%; } }
</style>
