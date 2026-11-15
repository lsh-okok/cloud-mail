<template>
  <section class="feature-page domains-page">
    <header class="page-heading">
      <div><h1>邮箱域名</h1><p>管理创建邮箱时可选的后缀，保存后立即生效。</p></div>
      <div class="heading-actions">
        <el-button :loading="loading || syncing" :disabled="!!busyDomain || saving" @click="reload">刷新</el-button>
        <el-button type="primary" :disabled="loading || !!busyDomain" @click="openCreate">添加域名</el-button>
      </div>
    </header>

    <el-alert type="info" :closable="false" show-icon>
      <template #title>域名只影响邮箱后缀，管理员登录账号不会随之变化</template>
      <p class="notice-text">停止创建只影响新邮箱，已有地址、邮件与登录继续保留。公网收件需配置 DNS、MX 记录和邮件接收服务；新域名发件还需配置 DKIM、SPF、DMARC，系统不会自动修改 DNS。</p>
    </el-alert>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"><el-button text :loading="loading" @click="reload">重新加载</el-button></el-alert>
    <el-alert v-if="syncError" :title="syncError" type="warning" show-icon :closable="false"><el-button text :loading="syncing" @click="syncSettings">重新同步</el-button></el-alert>

    <div v-loading="loading" class="list-region" aria-live="polite" :aria-busy="loading">
      <div v-if="items.length" class="domain-list">
        <div class="domain-list-heading" aria-hidden="true"><span>邮箱域名</span><span>创建状态</span><span>已有邮箱</span><span>操作</span></div>
        <article v-for="item in items" :key="item.domain" class="domain-row">
          <div class="domain-name"><strong>{{ item.domain }}</strong><el-tag v-if="item.isDefault" type="primary" size="small">默认域名</el-tag></div>
          <div class="domain-status"><span class="mobile-label">创建状态</span><el-tag :type="item.enabled ? 'success' : 'info'">{{ item.enabled ? '允许创建' : '停止创建' }}</el-tag></div>
          <div class="domain-counts"><span>{{ item.accountCount ?? 0 }} 个邮箱</span><span>{{ item.mailboxCount ?? 0 }} 个主邮箱</span></div>
          <div class="domain-actions">
            <el-button v-if="!item.isDefault && item.enabled" link type="primary" :loading="busyDomain === item.domain && busyAction === 'default'" :disabled="actionsDisabled" @click="setDefault(item)">设为默认</el-button>
            <el-tooltip v-if="item.isDefault" content="请先将其他域名设为默认，再停止此域名创建邮箱" placement="top"><span><el-button link disabled>停止创建</el-button></span></el-tooltip>
            <el-button v-else link :type="item.enabled ? 'warning' : 'success'" :loading="busyDomain === item.domain && busyAction === 'enabled'" :disabled="actionsDisabled" @click="toggle(item)">{{ item.enabled ? '停止创建' : '允许创建' }}</el-button>
          </div>
        </article>
      </div>
      <el-empty v-else-if="!loading && !error" description="尚未配置邮箱域名"><el-button type="primary" @click="openCreate">添加域名</el-button></el-empty>
    </div>
    <p class="form-help">默认域名会优先用于创建邮箱。域名可随时新增或停止创建，无需重新构建镜像或重启服务。</p>

    <el-dialog v-model="dialog" title="添加邮箱域名" width="min(520px, calc(100vw - 28px))" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @opened="domainInput?.focus()">
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="域名"><el-input ref="domainInput" v-model="newDomain" placeholder="例如 example.com" autocomplete="off" :disabled="saving" maxlength="253" /></el-form-item>
        <p class="form-help">填写域名即可，无需填写 @、邮箱前缀或 https://。支持国际化域名，保存时会统一规范格式。</p>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon />
        <el-button class="submit-domain" type="primary" native-type="submit" :loading="saving">添加域名</el-button>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="dialog = false">取消</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'
import { websiteConfig } from '@/request/setting.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { useSettingStore } from '@/store/setting.js'
import '@/views/links/features.css'

const settingStore = useSettingStore()
const { data, loading, error, refresh } = useFeatureResource(signal => adminFeatureRequest('/admin/domains', { signal }), { items: [] })
const items = computed(() => data.value?.items || [])
const dialog = ref(false), domainInput = ref(null), newDomain = ref(''), saving = ref(false), formError = ref('')
const busyDomain = ref(''), busyAction = ref(''), syncing = ref(false), syncError = ref('')
const actionsDisabled = computed(() => loading.value || saving.value || !!busyDomain.value)

async function syncSettings() {
  syncing.value = true
  try {
    const settings = await websiteConfig()
    settingStore.settings = settings
    settingStore.domainList = settings.domainList || []
    syncError.value = ''
  } catch {
    syncError.value = '邮箱后缀列表同步失败，请重新同步后再创建邮箱。已保存的域名配置不受影响。'
  } finally { syncing.value = false }
}
async function reload() {
  await Promise.allSettled([refresh(), syncSettings()])
}
function openCreate() {
  newDomain.value = ''; formError.value = ''; dialog.value = true
}
async function save() {
  if (saving.value) return
  const domain = newDomain.value.trim().toLowerCase()
  if (!domain) { formError.value = '请输入邮箱域名'; return }
  if (/[\s@:/\\?#]/.test(domain)) { formError.value = '请输入域名，例如 example.com，不要包含 @、网址或路径'; return }
  saving.value = true; formError.value = ''
  try {
    await adminFeatureRequest('/admin/domains', { method: 'POST', data: { domain } })
    dialog.value = false
    ElMessage.success('邮箱域名已添加')
    await reload()
  } catch (cause) { formError.value = cause.message || '添加失败，请重试' }
  finally { saving.value = false }
}
async function update(item, values, action, message) {
  if (actionsDisabled.value) return
  busyDomain.value = item.domain; busyAction.value = action
  try {
    await adminFeatureRequest(`/admin/domains/${encodeURIComponent(item.domain)}`, { method: 'PUT', data: values })
    ElMessage.success(message)
    await reload()
  } catch (cause) { ElMessage.error(cause.message || '保存失败，请重试') }
  finally { busyDomain.value = ''; busyAction.value = '' }
}
function setDefault(item) {
  return update(item, { isDefault: true }, 'default', '默认邮箱域名已更新')
}
async function toggle(item) {
  if (actionsDisabled.value || item.isDefault) return
  if (item.enabled) {
    try {
      await ElMessageBox.confirm(`停止使用 ${item.domain} 创建新邮箱？已有邮箱、邮件、登录和收件链接继续保留。`, '停止创建邮箱', { type: 'warning', confirmButtonText: '停止创建', cancelButtonText: '取消' })
    } catch { return }
  }
  await update(item, { enabled: !item.enabled }, 'enabled', item.enabled ? '已停止使用此域名创建新邮箱' : '已允许使用此域名创建新邮箱')
}
reload()
</script>

<style scoped>
.notice-text{margin:6px 0 0;line-height:1.7}.domain-list{border:1px solid var(--el-border-color-light);border-radius:10px;overflow:hidden;background:var(--el-bg-color)}.domain-list-heading,.domain-row{display:grid;grid-template-columns:minmax(180px,1.6fr) 110px minmax(140px,1fr) minmax(160px,1fr);gap:18px;align-items:center;padding:16px 20px}.domain-list-heading{background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:13px}.domain-row+.domain-row{border-top:1px solid var(--el-border-color-lighter)}.domain-name{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-width:0}.domain-name strong{overflow-wrap:anywhere;font-size:15px}.domain-counts{display:flex;flex-wrap:wrap;gap:5px 14px;font-size:13px;color:var(--el-text-color-secondary)}.domain-actions{display:flex;flex-wrap:wrap;gap:8px 14px}.domain-actions .el-button+.el-button{margin-left:0}.mobile-label{display:none}.submit-domain{width:100%;margin-top:12px}.domains-page>.form-help{margin-top:16px}
@media(max-width:900px){.domain-list-heading,.domain-row{grid-template-columns:minmax(160px,1.5fr) 92px minmax(100px,1fr) minmax(125px,1fr);gap:10px;padding:15px}}
@media(max-width:767px){.domain-list-heading{display:none}.domain-row{grid-template-columns:minmax(0,1fr) auto;gap:13px;padding:18px 14px}.domain-name{grid-column:1/-1}.domain-status{display:flex;gap:8px;align-items:center}.mobile-label{display:inline;color:var(--el-text-color-secondary);font-size:12px}.domain-counts{grid-column:1/-1;grid-row:3}.domain-actions{justify-content:flex-end;gap:8px}.domain-row .el-tag{max-width:100%}}
@media(max-width:380px){.domain-row{grid-template-columns:1fr}.domain-name,.domain-counts{grid-column:1}.domain-counts{grid-row:auto}.domain-actions{justify-content:flex-start}}
</style>
