<template>
  <div class="smtp-panel">
    <div class="toolbar"><el-button :loading="loading" :disabled="saving" @click="loadConfig">重新加载发件配置</el-button><el-button type="primary" :disabled="!loaded || !data?.encryptionAvailable" @click="openPool()">添加发件池账号</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="loadConfig">重试</el-button></el-alert>
    <el-alert v-if="loaded && !data?.encryptionAvailable" title="服务器尚未配置凭据加密密钥，暂不可保存 SMTP 授权码。" type="warning" :closable="false" />
    <el-alert v-if="loaded && data.pool.length && !usablePool" title="发件池已存在，但没有可用的启用账号。收信验证将被拒绝，不会自动退回默认发件人。" type="warning" :closable="false" />
    <div v-loading="loading" class="smtp-layout"><article class="config-card"><h2>默认发件人</h2><p class="form-help">发件池为空时使用默认账号。授权码由服务器加密保存，查询配置不会返回授权码。</p><el-form label-position="top" @submit.prevent="saveDefault"><SenderFields :form="defaultForm" :presets="data?.presets || []" :disabled="!loaded || saving || !data?.encryptionAvailable" :has-password="!!data?.default?.hasPassword" /><el-checkbox v-if="data?.default?.hasPassword" v-model="defaultForm.clearPassword" :disabled="!loaded || saving">清除已保存授权码</el-checkbox><p v-if="defaultForm.clearPassword" class="form-help">清除后默认发件人无法发送验证邮件，直至保存新授权码。</p><el-alert v-if="defaultError" :title="defaultError" type="error" :closable="false" /><el-button native-type="submit" type="primary" :loading="saving" :disabled="!loaded || !data?.encryptionAvailable">保存默认发件人</el-button></el-form></article>
      <article class="config-card"><h2>发件池 <small>{{data?.pool.length || 0}} 个账号</small></h2><p class="form-help">存在发件池时优先轮换其中启用且具有授权码的账号。发信全局串行，并遵守任务设置的发送间隔。</p><el-empty v-if="loaded && !data.pool.length" description="发件池为空，将使用默认发件人" /><div v-for="sender in data?.pool || []" :key="sender.id" class="sender-card"><div class="sender-heading"><strong>{{sender.email}}</strong><el-tag :type="sender.enabled ? 'success' : 'info'">{{sender.enabled ? '启用' : '停用'}}</el-tag></div><p>{{sender.host}}:{{sender.port}} · {{sender.encryption.toUpperCase()}}</p><p>{{sender.hasPassword ? '已保存授权码' : '尚无授权码'}} · 最近使用 {{formatTime(sender.lastUsedAt)}}</p><div class="card-actions"><el-button :disabled="!loaded" @click="openPool(sender)">编辑</el-button><el-button :loading="busyId === sender.id" :disabled="!loaded" @click="toggleSender(sender)">{{sender.enabled ? '停用' : '启用'}}</el-button><el-button type="danger" plain :disabled="!loaded || busyId === sender.id" @click="deleteSender(sender)">删除</el-button></div></div></article></div>
    <el-dialog v-model="poolVisible" :title="editing ? '编辑发件池账号' : '添加发件池账号'" width="min(620px, calc(100vw - 28px))" :close-on-click-modal="!poolSaving" :close-on-press-escape="!poolSaving" :show-close="!poolSaving" @closed="poolForm.password = ''"><el-form label-position="top"><SenderFields :form="poolForm" :presets="data?.presets || []" :disabled="poolSaving" :has-password="!!editing?.hasPassword" /><el-form-item label="用于轮换发信"><el-switch v-model="poolForm.enabled" :disabled="poolSaving" /></el-form-item></el-form><el-alert v-if="poolError" :title="poolError" type="error" :closable="false" /><template #footer><el-button :disabled="poolSaving" @click="poolVisible = false">取消</el-button><el-button type="primary" :loading="poolSaving" :disabled="!loaded" @click="savePool">保存发件池账号</el-button></template></el-dialog>
  </div>
</template>
<script setup>
import {computed,reactive,ref} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import {adminFeatureRequest} from '@/request/features.js'
import {useFeatureResource} from '@/composables/use-feature-resource.js'
import {formatTime} from './labels.js'
import SenderFields from './sender-fields.vue'
const {data,loading,error,refresh}=useFeatureResource(signal=>adminFeatureRequest('/admin/verification/smtp',{signal}))
const loaded=ref(false),saving=ref(false),defaultError=ref(''),busyId=ref(''),poolVisible=ref(false),editing=ref(null),poolSaving=ref(false),poolError=ref('')
const blank=()=>({host:'',port:465,email:'',encryption:'tls',password:'',clearPassword:false,enabled:true})
const defaultForm=reactive(blank()),poolForm=reactive(blank())
const usablePool=computed(()=>data.value?.pool.some(item=>item.enabled&&item.hasPassword))
function senderData(form){return{host:form.host.trim(),port:form.port,email:form.email.trim(),encryption:form.encryption,...(form.password&&!form.clearPassword?{password:form.password}:{})}}
async function loadConfig(){loaded.value=false;const value=await refresh();if(value){Object.assign(defaultForm,blank(),value.default||{},{password:'',clearPassword:false});loaded.value=true}}
async function saveDefault(){
  if(!loaded.value||saving.value)return
  saving.value=true
  try{
    if(defaultForm.clearPassword)await ElMessageBox.confirm('清除默认发件人的授权码后，此账号将不能发送验证邮件。确认清除？','清除默认授权码',{type:'warning',confirmButtonText:'确认清除',cancelButtonText:'取消'})
    defaultError.value=''
    await adminFeatureRequest('/admin/verification/smtp/default',{method:'PUT',data:{...senderData(defaultForm),...(defaultForm.clearPassword?{clearPassword:true}:{})}})
    defaultForm.password='';await loadConfig();ElMessage.success('默认发件人已保存')
  }catch(cause){if(cause instanceof Error)defaultError.value=cause.message}finally{saving.value=false}
}
function openPool(sender=null){editing.value=sender;Object.assign(poolForm,blank(),sender||{},{password:''});poolError.value='';poolVisible.value=true}
async function savePool(){if(!loaded.value||poolSaving.value)return;poolSaving.value=true;poolError.value='';try{await adminFeatureRequest(editing.value?`/admin/verification/smtp/pool/${encodeURIComponent(editing.value.id)}`:'/admin/verification/smtp/pool',{method:editing.value?'PUT':'POST',data:{...senderData(poolForm),enabled:poolForm.enabled}});poolForm.password='';poolVisible.value=false;await loadConfig();ElMessage.success('发件池账号已保存')}catch(cause){poolError.value=cause.message}finally{poolSaving.value=false}}
async function toggleSender(sender){if(!loaded.value||busyId.value)return;busyId.value=sender.id;try{await adminFeatureRequest(`/admin/verification/smtp/pool/${encodeURIComponent(sender.id)}`,{method:'PUT',data:{...senderData(sender),enabled:!sender.enabled}});await loadConfig()}catch(cause){ElMessage.error(cause.message)}finally{busyId.value=''}}
async function deleteSender(sender){if(!loaded.value||busyId.value)return;busyId.value=sender.id;try{await ElMessageBox.confirm(`删除发件池账号 ${sender.email} 及其已保存授权码？历史任务的发件人快照会保留。`,'删除发件人',{type:'warning',confirmButtonText:'确认删除',cancelButtonText:'取消'});await adminFeatureRequest(`/admin/verification/smtp/pool/${encodeURIComponent(sender.id)}`,{method:'DELETE'});await loadConfig()}catch(cause){if(cause instanceof Error)ElMessage.error(cause.message)}finally{busyId.value=''}}
loadConfig()
</script>
<style scoped>.smtp-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.config-card{border:1px solid var(--el-border-color-light);border-radius:12px;padding:22px;min-width:0}.config-card h2{font-size:18px;margin:0 0 12px}.config-card h2 small{font-weight:400;font-size:12px;color:var(--el-text-color-secondary)}.sender-card{border-top:1px solid var(--el-border-color-light);padding:18px 0}.sender-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.sender-heading strong{overflow-wrap:anywhere}.sender-card p{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;overflow-wrap:anywhere}.config-card .el-checkbox{margin-bottom:16px}@media(max-width:900px){.smtp-layout{grid-template-columns:1fr}}</style>
