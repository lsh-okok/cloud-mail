<template>
  <section class="feature-page">
    <header class="page-heading"><div><h1>主邮箱管理</h1><p>与收件箱共用管理员邮箱目录，为归入同一主邮箱的子地址分别生成独立收件链接。</p></div><div class="heading-actions"><el-button @click="settingsRef.open()">取信服务设置</el-button><el-button @click="batchRef.open()">批量创建邮箱</el-button><el-button type="primary" @click="openCreate">添加主邮箱</el-button></div></header>
    <div class="toolbar"><el-input v-model="query.q" clearable placeholder="搜索主邮箱地址" @keyup.enter="search" @clear="search" /><el-button @click="search">查询</el-button><el-button :loading="loading" @click="refresh">刷新</el-button></div>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"><el-button text @click="refresh">重新加载</el-button></el-alert>
    <div v-loading="loading" class="list-region">
      <el-table class="mailbox-table" :data="items" row-key="id" :empty-text="loading || error ? ' ' : '尚未配置主邮箱'">
        <el-table-column prop="email" label="主邮箱地址" min-width="210" show-overflow-tooltip><template #default="{ row }"><strong>{{ row.email }}</strong></template></el-table-column>
        <el-table-column label="公开取信" width="120"><template #default="{ row }"><el-tag :type="row.localAccountStatus === 'disabled' ? 'warning' : row.enabled ? 'success' : 'info'">{{ row.localAccountStatus === 'disabled' ? '邮箱已停用' : row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="邮件来源" width="122"><template #default>MX / 本地收件</template></el-table-column>
        <el-table-column prop="publicId" label="公开标识" min-width="124" show-overflow-tooltip />
        <el-table-column label="收件范围" min-width="170" show-overflow-tooltip><template #default="{ row }">{{ row.mxDomain ? `受控域名 ${row.mxDomain}` : row.email }}</template></el-table-column>
        <el-table-column label="操作" width="224" :fixed="isDesktop ? 'right' : false"><template #default="{ row }"><div class="mailbox-actions"><el-button link type="primary" :disabled="row.localAccountStatus === 'disabled'" @click="goLinks(row)">管理子邮箱链接</el-button><el-button link type="primary" :disabled="row.localAccountStatus === 'disabled'" @click="openEdit(row)">编辑</el-button><el-button link :loading="busyId === row.id" :disabled="row.localAccountStatus === 'disabled'" :type="row.enabled ? 'warning' : 'success'" @click="toggle(row)">{{ row.enabled ? '停用' : '恢复' }}</el-button></div></template></el-table-column>
        <template #empty><el-empty v-if="!loading && !error" description="尚未配置主邮箱" /></template>
      </el-table>
    </div>
    <el-pagination v-if="total" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" :page-sizes="[20, 50, 100]" layout="total, prev, pager, next, sizes" @current-change="refresh" @size-change="search" />

    <el-dialog v-model="dialog" :title="editing ? '编辑主邮箱' : '添加主邮箱'" width="min(600px, calc(100vw - 28px))" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <template v-if="!editing">
        <el-form label-position="top" @submit.prevent="save"><el-form-item label="邮箱"><div class="add-mailbox-row"><el-input v-model="createForm.prefix" autofocus placeholder="输入邮箱前缀" autocomplete="off" :disabled="saving" @keyup.enter="save"><template #append><el-select v-model="createForm.suffix" placeholder="选择域名" :loading="domainsLoading" :disabled="saving || !domainsLoaded" class="domain-select"><el-option v-for="domain in domainOptions" :key="domain" :label="domain" :value="domain" /></el-select></template></el-input><el-button type="primary" native-type="submit" :loading="saving" :disabled="!domainsLoaded || !domainOptions.length">添加</el-button></div></el-form-item><p class="form-help">添加后即可在收件箱中使用此邮箱，并为归入该主邮箱的子地址生成独立收件链接。</p><el-alert v-if="domainsError" :title="domainsError" type="error" :closable="false"><el-button text :loading="domainsLoading" @click="loadDomains">重新加载域名</el-button></el-alert><el-alert v-else-if="domainsLoaded && !domainOptions.length" title="当前没有可添加邮箱的受控域名，请先配置收件域名。" type="warning" :closable="false" /></el-form>
      </template>
      <el-form v-else label-position="top" @submit.prevent="save">
        <el-form-item label="主邮箱完整地址"><el-input v-model="form.email" placeholder="例如 parent@example.com" type="email" :disabled="saving" /></el-form-item>
        <el-form-item label="收件范围"><el-radio-group v-model="form.mxMode"><el-radio value="account">已有本地邮箱账号</el-radio><el-radio value="domain">整个受控域名</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="form.mxMode === 'account'" label="本地邮箱账号 ID"><el-input-number v-model="form.localAccountId" :min="1" :precision="0" style="width:100%" /><div class="form-help">关联与主邮箱地址一致的已有账号。子邮箱邮件归入该账号，各收件链接仍按完整子地址隔离；不会创建新账号。</div></el-form-item>
        <el-form-item v-else label="受控 MX 域名"><el-input v-model="form.mxDomain" placeholder="example.com" /><div class="form-help">选择本机已接收的域名；可为该域名下已收到邮件的完整地址生成链接，各地址之间独立取信。</div></el-form-item>
      </el-form>
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
      <template #footer><el-button :disabled="saving" @click="dialog = false">取消</el-button><el-button v-if="editing" type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
    <FeatureSettings ref="settingsRef" />
    <BatchMailboxes ref="batchRef" />
  </section>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'
import { useFeatureQuery } from '@/composables/use-feature-query.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { useSettingStore } from '@/store/setting.js'
import { useAccountStore } from '@/store/account.js'
import { isEmail } from '@/utils/verify-utils.js'
import '@/views/links/features.css'
import FeatureSettings from './feature-settings.vue'
import BatchMailboxes from './batch-mailboxes.vue'

const router = useRouter()
const isDesktop = useMediaQuery('(min-width: 768px)')
const settingsRef = ref(null)
const batchRef = ref(null)
const settingStore = useSettingStore()
const accountStore = useAccountStore()
const query = reactive({ page: 1, pageSize: 20, q: '' })
const { items, total, loading, error, refresh } = useFeatureQuery(signal => adminFeatureRequest('/admin/mailboxes', { query, signal }))
let observedListRevision = accountStore.listRevision
watch(() => accountStore.listRevision, revision => {
  if (revision !== observedListRevision) {
    observedListRevision = revision
    refresh()
  }
})
const dialog = ref(false), editing = ref(null), saving = ref(false), formError = ref(''), busyId = ref('')
const form = reactive({ email: '', mxMode: 'domain', mxDomain: '', localAccountId: 1 })
const createForm = reactive({prefix:'',suffix:''}), domainOptions=ref([]), domainsLoaded=ref(false)
const {loading:domainsLoading,error:domainsError,refresh:refreshDomains}=useFeatureResource(signal=>adminFeatureRequest('/admin/mailboxes/domains',{signal}))
let minEmailPrefix=0
async function loadDomains(){
  domainsLoaded.value=false
  const result=await refreshDomains()
  if(!result)return
  domainOptions.value=[...new Set((result.domains||[]).map(value=>`@${String(value).replace(/^@/,'').toLowerCase()}`))]
  minEmailPrefix=Number(result.minEmailPrefix??settingStore.settings.minEmailPrefix??0)
  if(!domainOptions.value.includes(createForm.suffix))createForm.suffix=domainOptions.value[0]||''
  domainsLoaded.value=true
}
function search() { query.page = 1; refresh() }
function openCreate() {
  editing.value = null
  Object.assign(form, { email: '', mxMode: 'domain', mxDomain: '', localAccountId: 1 })
  createForm.prefix='';loadDomains()
  formError.value = ''; dialog.value = true
}
function openEdit(item) {
  editing.value = item
  Object.assign(form, { email: item.email, mxMode: item.mxDomain ? 'domain' : 'account', mxDomain: item.mxDomain || '', localAccountId: item.localAccountId || 1 })
  formError.value = ''; dialog.value = true
}
async function save() {
  if (saving.value) return
  formError.value = ''
  const prefix=createForm.prefix.trim().toLowerCase()
  if(!editing.value){
    if(!domainsLoaded.value||!domainOptions.value.includes(createForm.suffix)){formError.value='请先选择已加载的受控域名';return}
    if(!prefix){formError.value='请输入邮箱前缀';return}
    if(prefix.length<minEmailPrefix){formError.value=`邮箱前缀至少需要 ${minEmailPrefix} 个字符`;return}
    if(!isEmail(prefix+createForm.suffix)){formError.value='请输入合法的邮箱前缀';return}
  }
  const email = editing.value ? form.email.trim().toLowerCase() : prefix+createForm.suffix
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) { formError.value = '请输入主邮箱完整地址'; return }
  const data = { email, provider: 'mx' }
  if(editing.value){
    if (form.mxMode === 'domain') { data.mxDomain = form.mxDomain.trim().toLowerCase(); data.localAccountId = null }
    else { data.localAccountId = form.localAccountId; data.mxDomain = null }
    data.revision = editing.value.revision
  }else data.createLocalAccount=true
  saving.value = true
  try {
    await adminFeatureRequest(editing.value ? `/admin/mailboxes/${encodeURIComponent(editing.value.id)}` : '/admin/mailboxes', { method: editing.value ? 'PUT' : 'POST', data })
    if(!editing.value)observedListRevision = ++accountStore.listRevision
    dialog.value = false
    ElMessage.success(editing.value?'主邮箱已保存':'邮箱已添加，可继续生成子邮箱收件链接'); await refresh()
  } catch (cause) { formError.value = cause.message } finally { saving.value = false }
}
async function toggle(item) {
  try {
    await ElMessageBox.confirm(item.enabled ? `停用 ${item.email} 的公开取信后，其所有子邮箱链接将无法取信，收件箱仍可正常收信。确认停用？` : `恢复 ${item.email} 及其子邮箱链接的公开取信？`, item.enabled ? '停用公开取信' : '恢复公开取信', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' })
    busyId.value = item.id
    await adminFeatureRequest(`/admin/mailboxes/${encodeURIComponent(item.id)}`, { method: 'PUT', data: { revision: item.revision, enabled: !item.enabled } })
    await refresh()
  } catch (cause) { if (cause instanceof Error) ElMessage.error(cause.message) } finally { busyId.value = '' }
}
function goLinks(item) { router.push({ name: 'links', query: { mailboxId: item.id } }) }
refresh()
</script>

<style scoped>
.mailbox-table{width:100%}.mailbox-table :deep(.el-table__cell){padding:14px 0}.mailbox-actions{display:flex;align-items:center;gap:14px;white-space:nowrap}.mailbox-actions .el-button+.el-button{margin-left:0}
.add-mailbox-row{display:flex;gap:12px;width:100%;align-items:stretch}.add-mailbox-row>.el-input{flex:1;min-width:0}.domain-select{width:190px}.add-mailbox-row :deep(.el-input-group__append){padding:0 20px}.add-mailbox-row>.el-button{height:32px}@media(max-width:480px){.add-mailbox-row{flex-wrap:wrap}.add-mailbox-row>.el-input{flex-basis:100%}.add-mailbox-row>.el-button{width:100%}.domain-select{width:155px}}
</style>
