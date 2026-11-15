<template>
  <el-dialog v-model="visible" title="取信服务设置" width="min(560px, calc(100vw - 28px))" :close-on-click-modal="!saving">
    <el-form v-loading="loading" label-position="top" @submit.prevent="save"><el-form-item label="公开根地址"><el-input v-model="form.publicBaseUrl" placeholder="https://mail.example.com 或 https://example.com/mail" :disabled="!ready || saving" /><p class="setting-help">复制和导出的收件链接优先使用此地址。可包含部署路径前缀；留空使用服务器配置的公开地址。</p></el-form-item><el-form-item label="系统时区"><el-select v-model="form.timeZone" filterable allow-create default-first-option style="width:100%" :disabled="!ready || saving"><el-option v-for="zone in ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/New_York']" :key="zone" :label="zone" :value="zone" /></el-select><p class="setting-help">用于每日计划的日期与执行时间；当前时间显示仍使用浏览器本地时区。</p></el-form-item></el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button v-if="!ready" text @click="load">重新加载</el-button></el-alert>
    <template #footer><el-button :disabled="saving" @click="visible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!ready" @click="save">保存设置</el-button></template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'
const visible = ref(false), ready = ref(false), loading = ref(false), saving = ref(false), error = ref('')
const form = reactive({ publicBaseUrl: '', timeZone: 'Asia/Shanghai', revision: 0 })
async function load() {
  loading.value = true; ready.value = false; error.value = ''
  try { Object.assign(form, await adminFeatureRequest('/admin/settings')); ready.value = true }
  catch (cause) { error.value = cause.message } finally { loading.value = false }
}
async function open() { visible.value = true; await load() }
async function save() {
  if (!ready.value || saving.value) return
  saving.value = true; error.value = ''
  try {
    Object.assign(form, await adminFeatureRequest('/admin/settings', { method: 'PUT', data: { publicBaseUrl: form.publicBaseUrl.trim(), timeZone: form.timeZone, revision: form.revision } }))
    ElMessage.success('取信服务设置已保存'); visible.value = false
  } catch (cause) { error.value = cause.message } finally { saving.value = false }
}
defineExpose({ open })
</script>

<style scoped>
.setting-help { margin-top: 8px; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); }
</style>
