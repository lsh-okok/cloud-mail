<template>
  <el-dialog :model-value="visible" @update:model-value="$emit('update:visible', $event)" title="邮箱验证任务详情" width="min(1180px, calc(100vw - 24px))" destroy-on-close>
    <div class="task-detail">
      <div class="detail-toolbar"><el-button :loading="loading" @click="refresh()">刷新</el-button><el-button :loading="exporting" :disabled="!data" @click="exportReport">完整 CSV 报告</el-button><el-select v-model="query.result" clearable placeholder="全部结果" @change="filterChanged"><el-option label="通过" value="passed" /><el-option label="失败" value="failed" /><el-option label="待确认" value="pending" /></el-select></div>
      <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="refresh()">重试</el-button></el-alert>
      <div v-if="data" v-loading="loading">
        <div class="task-summary"><strong>#{{ data.task.number }} · {{ data.task.type === 'receive' ? '实际收信验证' : '链接检测' }}</strong><el-tag :type="statusType(data.task.status)">{{ statusLabel(data.task.status) }}</el-tag><span>已处理 {{ data.task.processed }} / {{ data.task.total }}</span><span>通过 {{ data.task.passed }} · 失败 {{ data.task.failed }} · 待确认 {{ data.task.pending }}</span></div>
        <p class="detail-note">待确认表示尚无确定收信结论；“已处理”单独表示本项处理流程是否结束。创建于 {{ formatTime(data.task.createdAt) }}，结束于 {{ formatTime(data.task.finishedAt) }}。</p>
        <el-alert v-if="data.task.error" :title="data.task.error" type="error" :closable="false" />
        <el-alert v-if="data.task.parentTaskId" :title="`此任务为复检：原未通过 ${data.task.originalUnpassed ?? '—'} 项，本次选择 ${data.task.total} 项，跳过 ${data.task.skipped?.length || 0} 项。收信复检只查原标识，不重新发信。`" type="info" :closable="false"><el-button text @click="$emit('open-task', data.task.parentTaskId)">查看原任务</el-button></el-alert>
        <el-collapse v-if="data.task.skipped?.length"><el-collapse-item :title="`查看 ${data.task.skipped.length} 个跳过原因`" name="skipped"><div v-for="(item, index) in skippedItems" :key="`${skipPage}-${index}`" class="skip-item"><strong>{{ item.recipient || item.sourceId || item.id }}</strong><span>{{ item.reason }}</span></div><el-pagination v-model:current-page="skipPage" :total="data.task.skipped.length" :page-size="20" layout="prev, pager, next" /></el-collapse-item></el-collapse>
        <template v-if="data.task.lastRecheck">
          <el-alert :title="`最近一次复检未创建任务：原未通过 ${data.task.lastRecheck.originalUnpassed} 项，本次可复检 ${data.task.lastRecheck.total} 项，跳过 ${data.task.lastRecheck.skipped?.length || 0} 项。`" type="warning" :closable="false"><p class="detail-note">{{ formatTime(data.task.lastRecheck.createdAt) }} · 请查看跳过原因，必要时重新选择范围并确认新建验证任务。</p></el-alert>
          <el-collapse v-if="data.task.lastRecheck.skipped?.length" v-model="lastRecheckExpanded"><el-collapse-item :title="`查看最近复检的 ${data.task.lastRecheck.skipped.length} 个跳过原因`" name="last-recheck"><div v-for="(item,index) in lastSkippedItems" :key="`${lastSkipPage}-${index}`" class="skip-item"><strong>{{item.recipient || item.sourceId || item.id}}</strong><span>{{item.reason}}</span></div><el-pagination v-model:current-page="lastSkipPage" :total="data.task.lastRecheck.skipped.length" :page-size="20" layout="prev, pager, next" /></el-collapse-item></el-collapse>
        </template>
        <el-table :data="data.items" class="desktop-results" style="width:100%"><el-table-column label="收件人 / 主邮箱" min-width="230"><template #default="{row}"><strong>{{ row.recipient }}</strong><div class="detail-note">{{ row.mailboxEmail }}</div></template></el-table-column><el-table-column label="结论 / 处理阶段" width="160"><template #default="{row}"><el-tag :type="row.result === 'passed' ? 'success' : row.result === 'failed' ? 'danger' : 'warning'">{{ resultLabel(row.result) }}</el-tag><div class="detail-note">{{ phaseLabel(row.phase) }} · {{ row.processed ? '已处理' : '未结束' }}</div></template></el-table-column><el-table-column label="检测信息" min-width="260"><template #default="{row}"><div>{{ row.note || '—' }}</div><div class="detail-note">HTTP {{ row.httpStatus || '—' }} · {{ row.mode === 'custom' ? '自定义来源' : '系统来源' }}</div><div v-if="row.marker" class="detail-note">标识：<code>{{ row.marker }}</code></div><div v-if="row.senderEmail" class="detail-note">发件人：{{ row.senderEmail }} · {{ formatTime(row.sentAt) }}</div></template></el-table-column><el-table-column label="检查时间" width="175"><template #default="{row}">{{ formatTime(row.checkedAt) }}</template></el-table-column></el-table>
        <div class="mobile-results"><article v-for="row in data.items" :key="row.id"><strong>{{ row.recipient }}</strong><p>{{ row.mailboxEmail }}</p><el-tag :type="row.result === 'passed' ? 'success' : row.result === 'failed' ? 'danger' : 'warning'">{{ resultLabel(row.result) }}</el-tag><p>{{ phaseLabel(row.phase) }} · {{ row.processed ? '已处理' : '未结束' }} · HTTP {{ row.httpStatus || '—' }}</p><p>{{ row.note || '—' }}</p><p v-if="row.marker">标识：<code>{{ row.marker }}</code></p><p v-if="row.senderEmail">{{ row.senderEmail }} · {{ formatTime(row.sentAt) }}</p><p>检查于 {{ formatTime(row.checkedAt) }}</p></article></div>
        <el-empty v-if="!data.items.length" description="当前筛选下没有检测项" />
        <el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="data.total" :page-sizes="[25,50,100]" layout="total, prev, pager, next, sizes" @current-change="refresh()" @size-change="filterChanged" />
      </div>
    </div>
  </el-dialog>
</template>
<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { adminFeatureRequest, downloadFeatureExport } from '@/request/features.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { useFeaturePolling } from '@/composables/use-feature-polling.js'
import { formatTime, isActive, phaseLabel, resultLabel, statusLabel, statusType } from './labels.js'
const props = defineProps({ visible: Boolean, taskId: {type:String,default:''} })
defineEmits(['update:visible','open-task'])
const query = reactive({page:1,pageSize:25,result:''}), exporting = ref(false), skipPage = ref(1)
const lastSkipPage=ref(1),lastRecheckExpanded=ref(['last-recheck'])
const {data,loading,error,refresh,cancel} = useFeatureResource(signal => adminFeatureRequest(`/admin/verification/tasks/${encodeURIComponent(props.taskId)}`, {query,signal}))
const skippedItems = computed(() => (data.value?.task.skipped || []).slice((skipPage.value - 1) * 20, skipPage.value * 20))
const lastSkippedItems = computed(() => (data.value?.task.lastRecheck?.skipped || []).slice((lastSkipPage.value - 1) * 20,lastSkipPage.value * 20))
function filterChanged(){query.page=1;refresh()}
async function exportReport(){if(exporting.value)return;exporting.value=true;try{await downloadFeatureExport(`/admin/verification/tasks/${encodeURIComponent(props.taskId)}/export`,null,{filename:`verification-${data.value.task.number}.csv`});ElMessage.success('完整报告已下载')}catch(cause){ElMessage.error(cause.message)}finally{exporting.value=false}}
watch(()=>[props.visible,props.taskId],()=>{cancel();data.value=null;error.value='';if(props.visible&&props.taskId){query.page=1;query.result='';skipPage.value=1;lastSkipPage.value=1;lastRecheckExpanded.value=['last-recheck'];refresh()}},{immediate:true})
useFeaturePolling(()=>refresh({quiet:true}),{enabled:()=>props.visible&&!!props.taskId&&isActive(data.value?.task),cancel})
</script>
<style scoped>
.detail-toolbar,.task-summary{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.detail-toolbar .el-select{width:160px}.detail-toolbar .el-button+.el-button{margin-left:0}.task-summary strong{font-size:17px}.detail-note{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.task-detail .el-alert{margin:16px 0}.task-detail .el-pagination{margin-top:18px;flex-wrap:wrap;row-gap:10px}.skip-item{display:flex;gap:14px;padding:7px 0;overflow-wrap:anywhere}.mobile-results{display:none}.mobile-results article{border:1px solid var(--el-border-color-light);border-radius:10px;padding:14px;overflow-wrap:anywhere}.mobile-results p{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}@media(max-width:767px){.desktop-results{display:none}.mobile-results{display:grid;gap:12px}.detail-toolbar .el-select{width:100%}.skip-item{display:grid;gap:4px}}
</style>
