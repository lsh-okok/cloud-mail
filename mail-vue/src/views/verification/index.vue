<template>
  <section class="feature-page verification-page">
    <header class="page-heading"><div><h1>邮箱验证</h1><p>按子邮箱的公开取信策略检查链接，或发送带唯一标识的测试邮件验证实际收信。</p></div><el-button type="primary" @click="openCreate">新建验证任务</el-button></header>
    <el-tabs v-model="tab"><el-tab-pane label="验证任务" name="tasks" /><el-tab-pane label="验证来源" name="sources" /><el-tab-pane label="SMTP 发件配置" name="smtp" /><el-tab-pane label="每日验证计划" name="plan" /></el-tabs>
    <template v-if="tab === 'tasks'">
      <div class="toolbar"><el-button :loading="loading" @click="refresh()">刷新任务</el-button><span class="poll-note">每 5 秒更新，离开页面或隐藏时暂停</span></div>
      <el-alert v-if="syncError" :title="`来源同步失败：${syncError}`" type="error" :closable="false"><el-button text :loading="syncing" @click="syncSources">重新同步</el-button></el-alert>
      <el-alert v-if="syncSummary?.conflictCount" :title="`来源同步发现 ${syncSummary.conflictCount} 个冲突，冲突项不会自动参与检测。请在验证来源查看原因。`" type="warning" :closable="false"><el-button text @click="tab = 'sources'">查看来源</el-button></el-alert>
      <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="refresh()">重新加载</el-button></el-alert>
      <div class="list-region" v-loading="loading">
        <el-table class="task-table" :data="data?.items || []" row-key="id" :empty-text="loading || error ? ' ' : '尚无验证任务'">
          <el-table-column label="验证任务" min-width="160"><template #default="{ row }"><strong>#{{ row.number }} · {{ row.type === 'receive' ? '实际收信验证' : '链接检测' }}</strong><div v-if="row.parentTaskId" class="task-note">复检任务</div><p v-if="row.error" class="task-error" :title="row.error">{{ row.error }}</p></template></el-table-column>
          <el-table-column label="状态" width="96"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="创建时间" min-width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="进度" min-width="140"><template #default="{ row }"><el-progress :percentage="row.total ? Math.min(100, Math.round(row.processed / row.total * 100)) : 0" :show-text="false" :status="row.status === 'failed' ? 'exception' : row.status === 'completed' ? 'success' : undefined" /><div class="task-note">已处理 {{ row.processed }} / {{ row.total }}</div></template></el-table-column>
          <el-table-column label="验证结果" min-width="136"><template #default="{ row }"><div class="task-counts"><span>通过 <b>{{ row.passed }}</b></span><span>失败 <b>{{ row.failed }}</b></span><span>待确认 <b>{{ row.pending }}</b></span></div></template></el-table-column>
          <el-table-column label="操作" width="238" :fixed="isDesktop ? 'right' : false"><template #default="{ row }"><div class="task-actions"><el-button link type="primary" @click="openDetail(row.id)">详情</el-button><el-button v-if="isActive(row)" link type="warning" :loading="busyId === row.id" @click="stopTask(row)">停止</el-button><el-button v-else link type="primary" :loading="busyId === row.id" @click="recheckTask(row)">复检未通过项</el-button><el-button link type="primary" :loading="exportId === row.id" @click="exportTask(row)">CSV 报告</el-button></div></template></el-table-column>
          <template #empty><el-empty v-if="!loading && !error" description="尚无验证任务" /></template>
        </el-table>
      </div>
      <el-pagination v-if="data?.total" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="data.total" :page-sizes="[25,50,100]" layout="total, prev, pager, next, sizes" @current-change="refresh()" @size-change="pageSizeChanged" />
    </template>
    <VerificationSources v-if="tab === 'sources'" @synced="value => syncSummary = value" />
    <SmtpSettings v-if="tab === 'smtp'" />
    <DailyPlan v-if="tab === 'plan'" @task-created="taskCreated" @open-task="openDetail" />
    <el-dialog v-model="createVisible" title="新建邮箱验证任务" width="min(680px, calc(100vw - 24px))" :close-on-click-modal="!creating" :close-on-press-escape="!creating" :show-close="!creating">
      <el-form label-position="top"><el-form-item label="验证方式"><el-radio-group v-model="form.type" :disabled="creating"><el-radio value="link">链接可用性</el-radio><el-radio value="receive">实际收信</el-radio></el-radio-group></el-form-item><el-alert :title="form.type === 'receive' ? '将向抽样后的子邮箱发送测试邮件，只有公开取信返回本次唯一标识才判定通过。' : '检查链接是否按公开取信规则可用。链接通过不代表已收到邮件，也不代表公网可达。'" :type="form.type === 'receive' ? 'warning' : 'info'" :closable="false" /><OptionsForm :options="form" :receive="form.type === 'receive'" :disabled="creating" /></el-form>
      <el-alert v-if="createError" :title="createError" type="error" :closable="false" /><p v-if="pendingCreate" class="form-help">重试将使用同一请求编号；网络故障不会因此创建第二份任务。修改参数会开始新的请求。</p><template #footer><el-button :disabled="creating" @click="createVisible = false">取消</el-button><el-button type="primary" :loading="creating" @click="createTask">{{form.type === 'receive' ? '确认范围并发信验证' : '开始链接检测'}}</el-button></template>
    </el-dialog>
    <TaskDetail v-model:visible="detailVisible" :task-id="detailId" @open-task="openDetail" />
  </section>
</template>
<script setup>
import { reactive, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest, createRequestKey, downloadFeatureExport } from '@/request/features.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { useFeaturePolling } from '@/composables/use-feature-polling.js'
import { defaultOptions, formatTime, isActive, snapshotOptions, statusLabel, statusType } from './labels.js'
import OptionsForm from './options-form.vue'
import TaskDetail from './task-detail.vue'
import VerificationSources from './sources.vue'
import SmtpSettings from './smtp-settings.vue'
import DailyPlan from './daily-plan.vue'
import '@/views/links/features.css'
const tab=ref('tasks'),query=reactive({page:1,pageSize:25})
const isDesktop=useMediaQuery('(min-width: 768px)')
const {data,loading,error,refresh,cancel}=useFeatureResource(signal=>adminFeatureRequest('/admin/verification/tasks',{query,signal}))
const syncSummary=ref(null),syncError=ref(''),syncing=ref(false)
const createVisible=ref(false),creating=ref(false),createError=ref(''),pendingCreate=ref(null),form=reactive({type:'link',...defaultOptions()})
const detailVisible=ref(false),detailId=ref(''),busyId=ref(''),exportId=ref(''),recheckKeys=new Map()
function pageSizeChanged(){query.page=1;refresh()}
function openDetail(id){detailId.value=id;detailVisible.value=true}
function openCreate(){Object.assign(form,{type:'link',...defaultOptions()});pendingCreate.value=null;createError.value='';createVisible.value=true}
watch(form,()=>{pendingCreate.value=null;createError.value=''}, {deep:true})
watch(tab,value=>{if(value==='tasks')refresh();else cancel()})
async function syncSources(){if(syncing.value)return;syncing.value=true;try{syncSummary.value=await adminFeatureRequest('/admin/verification/sync',{method:'POST',data:{}});syncError.value=''}catch(cause){syncError.value=cause.message}finally{syncing.value=false}}
async function createTask(){
  if(creating.value)return
  creating.value=true
  try{
    if(form.type==='receive')await ElMessageBox.confirm(`将向${form.mailboxIds.length ? `选定的 ${form.mailboxIds.length} 个主邮箱` : '全部主邮箱'}下当前有效的子邮箱发送测试邮件，${form.sample==='all'?'检测全部子地址':`每个主邮箱抽取 ${form.sample} 个子地址`}。确认使用已配置的 SMTP 发件人发送？`,'确认发送测试邮件',{type:'warning',confirmButtonText:'确认发信并创建任务',cancelButtonText:'取消'})
    createError.value=''
    if(!pendingCreate.value)pendingCreate.value={...snapshotOptions(form),type:form.type,...(form.type==='receive'?{confirmSend:true}:{}),idempotencyKey:createRequestKey()}
    const task=await adminFeatureRequest('/admin/verification/tasks',{method:'POST',data:pendingCreate.value})
    pendingCreate.value=null;createVisible.value=false;taskCreated(task)
  }catch(cause){if(cause instanceof Error)createError.value=cause.message}finally{creating.value=false}
}
function taskCreated(task){tab.value='tasks';query.page=1;refresh();openDetail(task.id);ElMessage.success('验证任务已创建')}
async function stopTask(task){if(busyId.value)return;try{await ElMessageBox.confirm(`停止任务 #${task.number}：保留已完成结果，未开始项不再发信，在途操作会被中断。确认停止？`,'停止验证任务',{type:'warning',confirmButtonText:'确认停止',cancelButtonText:'取消'});busyId.value=task.id;await adminFeatureRequest(`/admin/verification/tasks/${encodeURIComponent(task.id)}/stop`,{method:'POST',data:{confirm:true}});await refresh()}catch(cause){if(cause instanceof Error)ElMessage.error(cause.message)}finally{busyId.value=''}}
async function recheckTask(task){
  if(busyId.value)return
  busyId.value=task.id
  try{
    await ElMessageBox.confirm(`为任务 #${task.number} 创建复检，只检查原先未通过且来源策略未变化的项目。变化项会跳过并显示原因。${task.type==='receive'?'收信复检沿用原测试标识，不重新发送邮件。':''}`,'复检未通过项',{confirmButtonText:'创建复检',cancelButtonText:'取消'})
    if(!recheckKeys.has(task.id))recheckKeys.set(task.id,createRequestKey())
    const next=await adminFeatureRequest(`/admin/verification/tasks/${encodeURIComponent(task.id)}/recheck`,{method:'POST',data:{idempotencyKey:recheckKeys.get(task.id)}})
    recheckKeys.delete(task.id);taskCreated(next)
  }catch(cause){
    if(cause.code==='NO_RECHECK_TARGETS'){
      recheckKeys.delete(task.id)
      const summary=cause.details
      ElMessage.warning(summary?`没有可复检项目：原未通过 ${summary.originalUnpassed} 项，跳过 ${summary.skipped?.length || 0} 项。请查看原任务详情。`:'没有可复检项目，请查看原任务详情中的跳过原因。')
      await refresh();openDetail(task.id)
    }else if(cause instanceof Error)ElMessage.error(cause.message)
  }finally{busyId.value=''}
}
async function exportTask(task){if(exportId.value)return;exportId.value=task.id;try{await downloadFeatureExport(`/admin/verification/tasks/${encodeURIComponent(task.id)}/export`,null,{filename:`verification-${task.number}.csv`});ElMessage.success('完整报告已下载')}catch(cause){ElMessage.error(cause.message)}finally{exportId.value=''}}
useFeaturePolling(()=>refresh({quiet:true}),{enabled:()=>tab.value==='tasks',cancel})
refresh();syncSources()
</script>
<style scoped>
.poll-note{font-size:12px;color:var(--el-text-color-secondary);align-self:center}
.task-table{width:100%}.task-table :deep(.el-table__cell){padding:14px 0}.task-note{font-size:12px;color:var(--el-text-color-secondary);margin-top:6px}.task-counts{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--el-text-color-secondary)}.task-counts span{white-space:nowrap}.task-counts b{color:var(--el-text-color-primary);margin-left:4px}.task-error{font-size:12px;color:var(--el-color-danger);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-actions{display:flex;align-items:center;gap:12px;white-space:nowrap}.task-actions .el-button+.el-button{margin-left:0}
.verification-page :deep(.el-tabs__nav-scroll){overflow-x:auto}.verification-page :deep(.el-tabs__nav){white-space:nowrap;float:none;width:max-content}
</style>
