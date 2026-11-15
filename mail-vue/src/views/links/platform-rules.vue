<template>
  <el-dialog v-model="visible" title="平台发件规则" width="min(820px, calc(100vw - 28px))" :close-on-click-modal="!saving">
    <p class="rule-help">子邮箱地址始终精确匹配。平台规则可进一步限定发件邮箱、发件域名和主题关键词。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="rule-layout" v-loading="loading">
      <aside><el-button :disabled="saving" @click="newRule">新建平台</el-button><el-empty v-if="!items.length && !loading" description="暂无平台规则" :image-size="60" /><button v-for="item in items" :key="item.id" type="button" class="rule-item" :class="{ active: editing?.id === item.id }" :disabled="saving" @click="edit(item)">{{ item.name }}</button></aside>
      <el-form label-position="top" @submit.prevent="save"><el-form-item label="平台名称"><el-input v-model="form.name" maxlength="80" placeholder="例如 GitHub" /></el-form-item><el-form-item label="发件邮箱"><el-input v-model="form.emails" type="textarea" :rows="2" placeholder="noreply@example.com" /></el-form-item><el-form-item label="发件域名"><el-input v-model="form.domains" type="textarea" :rows="2" placeholder="example.com" /><div class="rule-help">邮箱和域名至少填写一项；域名同时匹配其子域，不匹配相似后缀。</div></el-form-item><el-form-item label="主题关键词（可选）"><el-input v-model="form.keywords" type="textarea" :rows="2" placeholder="每行一个关键词，任意命中一项即可" /></el-form-item><div class="rule-actions"><el-button type="primary" :loading="saving" :disabled="loading || !!loadError" @click="save">{{ editing ? '保存规则' : '创建平台' }}</el-button><el-button v-if="editing" type="danger" plain :disabled="saving" @click="remove">删除平台</el-button><el-button v-if="loadError" @click="reload">重新加载</el-button></div></el-form>
    </div>
    <template #footer><el-button :disabled="saving" @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'

const emit = defineEmits(['changed'])
const visible = ref(false), items = ref([]), editing = ref(null), loading = ref(false), saving = ref(false), error = ref(''), loadError = ref(false)
const form = reactive({ name: '', emails: '', domains: '', keywords: '' })
function newRule() { editing.value = null; Object.assign(form, { name: '', emails: '', domains: '', keywords: '' }); error.value = '' }
function edit(item) { editing.value = item; Object.assign(form, { name: item.name, emails: item.emails.join('\n'), domains: item.domains.join('\n'), keywords: item.keywords.join('\n') }); error.value = '' }
async function reload() {
  loading.value = true; error.value = ''; loadError.value = false
  try { const result = await adminFeatureRequest('/admin/platforms'); items.value = result.items }
  catch (cause) { error.value = cause.message; loadError.value = true }
  finally { loading.value = false }
}
async function open() { newRule(); visible.value = true; await reload() }
const split = text => text.split(/[\n,，;；]+/).map(value => value.trim()).filter(Boolean)
async function save() {
  if (saving.value || loading.value || loadError.value) return
  saving.value = true; error.value = ''
  try {
    const data = { name: form.name.trim(), emails: split(form.emails), domains: split(form.domains), keywords: split(form.keywords), ...(editing.value ? { revision: editing.value.revision } : {}) }
    const item = await adminFeatureRequest(editing.value ? `/admin/platforms/${encodeURIComponent(editing.value.id)}` : '/admin/platforms', { method: editing.value ? 'PUT' : 'POST', data })
    await reload(); edit(item); emit('changed'); ElMessage.success('平台规则已保存')
  } catch (cause) { error.value = cause.message } finally { saving.value = false }
}
async function remove() {
  try {
    await ElMessageBox.confirm(`确认删除平台“${editing.value.name}”？仍被链接引用的平台将拒绝删除。`, '删除平台', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    saving.value = true
    await adminFeatureRequest(`/admin/platforms/${encodeURIComponent(editing.value.id)}`, { method: 'DELETE' })
    newRule(); await reload(); emit('changed')
  } catch (cause) { if (cause instanceof Error) error.value = cause.message } finally { saving.value = false }
}
defineExpose({ open })
</script>

<style scoped>
.rule-help { font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); margin-bottom: 14px; }
.rule-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 24px; min-height: 300px; margin-top: 18px; }
aside { border-right: 1px solid var(--el-border-color-light); padding-right: 16px; }
aside > .el-button { width: 100%; margin-bottom: 12px; }
.rule-item { display: block; text-align: left; width: 100%; padding: 10px; border-radius: 6px; cursor: pointer; color: var(--el-text-color-primary); overflow-wrap: anywhere; }
.rule-item.active, .rule-item:hover { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.rule-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rule-actions .el-button + .el-button { margin-left: 0; }
@media (max-width: 600px) { .rule-layout { grid-template-columns: 1fr; gap: 16px; } aside { display: flex; flex-wrap: wrap; gap: 6px; border-right: 0; border-bottom: 1px solid var(--el-border-color-light); padding: 0 0 12px; } aside > .el-button, .rule-item { width: auto; } }
</style>
