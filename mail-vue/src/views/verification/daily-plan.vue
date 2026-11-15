<template>
  <div class="plan-panel">
    <div class="toolbar"><el-button :loading="loading" :disabled="saving || running" @click="loadPlan">重新加载计划</el-button><el-button :loading="running" :disabled="!loaded || saving" @click="runSaved">立即执行已保存计划</el-button><el-tag v-if="dirty" type="warning" class="dirty-tag">存在未保存修改</el-tag></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="loadPlan">重试</el-button></el-alert>
    <el-alert title="每日计划只执行实际收信验证，会发送测试邮件。按服务器时区每日认领一次；错过当天时点后恢复会补当天一次，不补历史日期。" type="info" :closable="false" />
    <div class="plan-layout" v-loading="loading"><article class="plan-card"><h2>计划配置</h2><el-form label-position="top" @submit.prevent="save"><el-form-item label="启用每日自动发信"><el-switch v-model="form.enabled" :disabled="!loaded || saving" /></el-form-item><el-form-item :label="`每日执行时间（${data?.timeZone || '服务器时区'}）`"><el-input v-model="form.time" type="time" :disabled="!loaded || saving" /></el-form-item><OptionsForm :options="form" receive :disabled="!loaded || saving" /><el-alert v-if="saveError" :title="saveError" type="error" :closable="false" /><el-button native-type="submit" type="primary" :loading="saving" :disabled="!loaded || running">{{form.enabled ? '确认自动发信并保存' : '保存停用计划'}}</el-button></el-form></article><article class="plan-card"><h2>已保存计划的运行状态</h2><dl><div><dt>启用状态</dt><dd>{{data ? (data.enabled ? '已启用' : '已停用') : '—'}}</dd></div><div><dt>系统时区</dt><dd>{{data?.timeZone || '—'}}</dd></div><div><dt>每日时间</dt><dd>{{data?.time || '—'}}</dd></div><div><dt>下次执行</dt><dd>{{formatTime(data?.nextRunAt)}}</dd></div><div><dt>上次认领日期</dt><dd>{{data?.lastClaimDate || '—'}}</dd></div><div><dt>上次运行</dt><dd>{{formatTime(data?.lastRunAt)}}</dd></div><div><dt>上次状态</dt><dd>{{data?.lastStatus ? statusLabel(data.lastStatus) : '—'}}</dd></div></dl><el-alert v-if="data?.lastError" :title="data.lastError" type="error" :closable="false" /><el-button v-if="data?.lastTaskId" @click="$emit('open-task', data.lastTaskId)">查看上次任务</el-button><p class="form-help">立即执行使用服务器已保存的参数，不使用左侧尚未保存的修改，也不会占用当天自动计划的执行日期。</p><el-alert v-if="runError" :title="runError" type="error" :closable="false" /><p v-if="runKey" class="form-help">上次请求结果未确认，重试会复用同一请求编号。</p></article></div>
  </div>
</template>
<script setup>
import {computed,reactive,ref} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import {adminFeatureRequest,createRequestKey} from '@/request/features.js'
import {useFeatureResource} from '@/composables/use-feature-resource.js'
import {useFeaturePolling} from '@/composables/use-feature-polling.js'
import {defaultOptions,formatTime,snapshotOptions,statusLabel} from './labels.js'
import OptionsForm from './options-form.vue'
const emit=defineEmits(['task-created','open-task'])
const {data,loading,error,refresh,cancel}=useFeatureResource(signal=>adminFeatureRequest('/admin/verification/plan',{signal}))
const loaded=ref(false),saving=ref(false),running=ref(false),saveError=ref(''),runError=ref(''),runKey=ref(''),savedSnapshot=ref('')
const form=reactive({...defaultOptions(),enabled:false,time:'02:00'})
const config=()=>({...snapshotOptions(form),mailboxIds:[...form.mailboxIds],enabled:form.enabled,time:form.time})
const dirty=computed(()=>loaded.value&&JSON.stringify(config())!==savedSnapshot.value)
let loadedRevision=0
async function loadPlan(){loaded.value=false;const value=await refresh();if(value){Object.assign(form,defaultOptions(),value,{mailboxIds:[...(value.mailboxIds||[])]});loadedRevision=value.revision;savedSnapshot.value=JSON.stringify(config());loaded.value=true}}
async function save(){
  if(!loaded.value||saving.value||running.value)return
  saving.value=true
  try{
    if(form.enabled)await ElMessageBox.confirm(`保存后将每天 ${form.time}（${data.value.timeZone}）按此范围自动发送测试邮件。${form.mailboxIds.length?`已指定 ${form.mailboxIds.length} 个主邮箱。`:'范围为全部主邮箱。'}确认启用自动发信？`,'确认每日自动发信',{type:'warning',confirmButtonText:'确认并保存',cancelButtonText:'取消'})
    saveError.value=''
    await adminFeatureRequest('/admin/verification/plan',{method:'PUT',data:{...config(),revision:loadedRevision,...(form.enabled?{confirmSend:true}:{})}})
    runKey.value='';await loadPlan();ElMessage.success('每日计划已保存')
  }catch(cause){if(cause instanceof Error)saveError.value=cause.message}finally{saving.value=false}
}
async function runSaved(){
  if(!loaded.value||running.value||saving.value)return
  running.value=true
  try{
    await ElMessageBox.confirm(`立即按已保存计划向${data.value.mailboxIds.length?`${data.value.mailboxIds.length} 个指定主邮箱`:'全部主邮箱'}的抽样子地址发送测试邮件。${dirty.value?'当前未保存的修改不会执行。':''}确认发送？`,'立即执行已保存计划',{type:'warning',confirmButtonText:'确认发信',cancelButtonText:'取消'})
    runError.value='';if(!runKey.value)runKey.value=createRequestKey()
    const task=await adminFeatureRequest('/admin/verification/plan/run',{method:'POST',data:{confirmSend:true,idempotencyKey:runKey.value}})
    runKey.value='';emit('task-created',task)
  }catch(cause){if(cause instanceof Error)runError.value=cause.message}finally{running.value=false}
}
useFeaturePolling(()=>refresh({quiet:true}),{enabled:()=>loaded.value&&!saving.value&&!running.value,cancel})
loadPlan()
</script>
<style scoped>.plan-layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:20px}.plan-card{border:1px solid var(--el-border-color-light);border-radius:12px;padding:22px;min-width:0}.plan-card h2{margin:0 0 20px;font-size:18px}.plan-card dl>div{flex-wrap:wrap;gap:6px 16px}.plan-card dt{min-width:90px}.dirty-tag{align-self:center}@media(max-width:900px){.plan-layout{grid-template-columns:1fr}}</style>
