<template>
  <section class="feature-page nodes-page">
    <header class="page-heading"><div><h1>节点管理</h1><p>新增节点后自动填好安装参数，复制一条命令即可安装并同步邮箱、链接和平台策略。</p></div><el-button type="primary" @click="openCreate">新增节点</el-button></header>
    <div class="node-stats"><article><span>未撤销节点</span><strong>{{ data?.summary.total ?? '—' }}</strong></article><article><span>在线节点</span><strong>{{ data?.summary.online ?? '—' }}</strong></article><article><span>可取信节点</span><strong>{{ data?.summary.ready ?? '—' }}</strong></article><article><span>主节点游标</span><strong>{{ data?.summary.primaryCursor ?? '—' }}</strong></article></div>
    <el-alert title="在线表示最近 15 秒内有成功心跳；只有配置已追平且已就绪的节点才能取信。停用和恢复仅控制接入，不会开关服务器。" type="info" :closable="false" />
    <div class="toolbar"><el-button :loading="loading" @click="refresh()">刷新状态</el-button><span class="poll-note">每 5 秒更新，页面隐藏时暂停</span></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button text @click="refresh()">重新加载</el-button></el-alert>
    <div class="list-region" v-loading="loading">
      <el-empty v-if="data && !data.items.length && !error" description="尚未创建子节点" />
      <div class="node-grid"><article v-for="node in data?.items || []" :key="node.id" class="node-card"><div class="node-heading"><div><h2>{{ node.name }}</h2><code>{{ node.id }}</code></div><el-tag :type="stateType(node.status)">{{ stateLabel(node.status) }}</el-tag></div><div class="ready-line"><el-tag :type="node.ready ? 'success' : 'info'" size="small">{{ node.ready ? '已就绪，可取信' : '未就绪，不提供取信' }}</el-tag><span v-if="node.online && !node.ready">已连接，等待配置追平</span></div><dl><div><dt>连接 IP</dt><dd>{{ node.ip || '尚未连接' }}</dd></div><div><dt>最近心跳</dt><dd>{{ formatTime(node.lastHeartbeatAt) }}</dd></div><div><dt>最近同步</dt><dd>{{ formatTime(node.lastSyncAt) }}</dd></div><div><dt>节点 / 主游标</dt><dd>{{ node.cursor }} / {{ node.primaryCursor }}</dd></div><div><dt>待同步事件</dt><dd>{{ node.pendingEvents }}</dd></div></dl><div v-if="node.status === 'initializing' || (node.snapshot?.total && node.snapshot.completed < node.snapshot.total)" class="snapshot"><div><span>首次快照同步</span><span>{{ node.snapshot?.completed || 0 }} / {{ node.snapshot?.total || 0 }}</span></div><el-progress :percentage="Math.max(0, Math.min(100, node.snapshot?.percent || 0))" /></div><p v-if="node.lastError" class="node-error">{{ node.lastError }}</p><div class="card-actions"><template v-if="!node.revoked"><el-button :type="node.disabled ? 'success' : 'warning'" plain :loading="busyId === node.id" @click="changeStatus(node)">{{ node.disabled ? '恢复接入' : '停用接入' }}</el-button><el-button type="danger" plain :disabled="busyId === node.id" @click="revoke(node)">永久撤销</el-button></template><el-button v-else type="danger" plain :loading="busyId === node.id" @click="removeRecord(node)">删除撤销记录</el-button></div></article></div>
    </div>
    <el-pagination v-if="data?.total" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="data.total" :page-sizes="[20, 50, 100]" layout="total, prev, pager, next, sizes" @current-change="refresh()" @size-change="pageSizeChanged" />

    <el-dialog v-model="createVisible" title="新增节点" width="min(520px, calc(100vw - 28px))" :close-on-click-modal="!creating" :close-on-press-escape="!creating" :show-close="!creating">
      <p class="deploy-intro">填写节点名称，创建后自动生成带该节点参数的一键安装命令，使用 GitHub 上统一维护的安装脚本。</p>
      <el-form label-position="top" @submit.prevent="create">
        <el-form-item label="节点名称"><el-input v-model="name" maxlength="80" show-word-limit placeholder="例如：家庭网络取信节点" :disabled="creating" @keyup.enter="create" /></el-form-item>
        <el-collapse v-model="createSections" class="deploy-advanced">
          <el-collapse-item title="部署设置" name="settings">
            <el-form-item label="主节点地址" :error="localPrimaryAddress ? '请填写主节点的局域网 IP 或域名，不能使用本机回环地址。' : ''"><el-input v-model="deployment.primaryUrl" placeholder="https://mail.example.com" :disabled="creating || optionsLoading" /><div class="form-help">请使用目标 Docker 容器能够访问的主节点局域网 IP 或域名；使用子路径时请保留完整路径。</div></el-form-item>
            <el-form-item label="节点访问端口"><el-input-number v-model="deployment.port" :min="1" :max="65535" :disabled="creating" controls-position="right" /><div class="form-help">默认 3001，请确保目标服务器上此端口可用。</div></el-form-item>
          </el-collapse-item>
        </el-collapse>
        <div v-if="usesHttp" class="http-consent"><el-checkbox v-model="deployment.allowInsecureHttp" :disabled="creating">允许通过受信局域网 HTTP 连接主节点</el-checkbox><p class="form-help">当前主地址使用 HTTP，连接内容未经加密。公网连接请改用 HTTPS。</p></div>
      </el-form>
      <el-alert v-if="optionsError" :title="optionsError" type="error" :closable="false"><el-button text :loading="optionsLoading" @click="loadDeploymentOptions">重新检查</el-button></el-alert>
      <el-alert v-else-if="!optionsLoading && !bundleAvailable" title="主节点尚未准备部署安装包，请先构建后端并重新启动服务。" type="warning" :closable="false" />
      <el-alert v-if="createError" :title="createError" type="error" :closable="false" />
      <p v-if="bundleFormat === 'docker-image'" class="form-help">支持 Linux，需有 curl。安装命令自动下载脚本和主节点已准备的安装包；无法访问软件源时请先安装 Docker。</p>
      <p v-else class="form-help">支持 Linux，需有 curl，并能访问 GitHub、主节点、Docker 镜像源及 npm 依赖。安装会自动配置并启动节点；缺少 Docker 时会尝试安装。</p>
      <template #footer><el-button :disabled="creating" @click="createVisible = false">取消</el-button><el-button type="primary" :loading="creating || optionsLoading" :disabled="!bundleAvailable || !!optionsError" @click="create">新增并生成安装命令</el-button></template>
    </el-dialog>
    <el-dialog v-model="credentialVisible" title="一键安装节点" width="min(800px, calc(100vw - 28px))" :before-close="beforeCloseCredential" :close-on-click-modal="false" @closed="clearCredential">
      <template v-if="created">
        <el-alert v-if="installationCommand" class="script-created" title="节点已新增，复制命令即可安装" description="下面一条命令会自动从 GitHub 下载脚本，带上当前节点参数并开始安装，无需单独下载或修改脚本。" type="success" :closable="false" />
        <div class="deploy-node-name"><strong>{{ created.node.name }}</strong><el-tag :type="deploymentStatus.type">{{ deploymentStatus.label }}</el-tag></div>
        <p class="deploy-intro">在目标 Linux 服务器终端中粘贴执行这一条命令即可。请使用 root 或具有 sudo 权限的用户，并确保已安装 curl。{{ created.deployment?.format === 'docker-image' ? '服务器需能访问 GitHub 和主节点；无法访问软件源时请先安装 Docker。' : '服务器需能访问 GitHub、主节点、Docker 镜像源及 npm 依赖。' }}</p>
        <el-alert v-if="installationExpired" title="本次安装参数已过期" description="首次安装需要重新新增节点并获取有效参数。GitHub 上的通用脚本仍可使用，已经安装成功的节点不受影响。" type="warning" :closable="false" />
        <el-alert v-else-if="!installationCommand" title="未收到完整安装命令，请更新主节点应用后重新新增节点。" type="error" :closable="false" />
        <div class="command-box"><pre aria-label="下载并安装节点的完整命令">{{ installationCommand }}</pre></div>
        <div class="deploy-command-actions">
          <el-button type="primary" size="large" :disabled="!installationCommand || installationUnavailable" @click="copyInstallation(installationCommand)">复制一键安装命令</el-button>
        </div>
        <p class="form-help">本次安装参数有效至 {{ formatTime(created.deployment?.expiresAt) }}，请在有效期内执行并下载完成安装包。主节点重启、节点停用或撤销、安装包更新会提前使参数失效。带参数的命令包含接入权限，请妥善保管。</p>
        <div class="deployment-progress" aria-live="polite">
          <el-alert :title="deploymentStatus.title" :description="deploymentStatus.description" :type="deploymentStatus.type" :closable="false" />
          <el-progress v-if="currentNode?.online && !currentNode.ready && currentNode.snapshot?.total" :percentage="Math.max(0, Math.min(100, currentNode.snapshot.percent || 0))" />
          <p v-if="currentNode?.lastError" class="node-error">{{ currentNode.lastError }}</p>
          <p v-if="error" class="node-error">状态更新失败：{{ error }}</p>
        </div>
        <el-collapse v-model="credentialSections" class="deploy-advanced">
          <el-collapse-item title="手动接入配置" name="manual">
            <p class="form-help">自动部署已包含以下配置，仅在手动部署或备份时使用。凭据只在本次创建后提供。</p>
            <p v-if="installerUrl" class="form-help">通用脚本来源：<el-link :href="installerUrl" target="_blank" rel="noopener noreferrer" type="primary" class="installer-link">GitHub</el-link></p>
            <el-form label-position="top">
              <el-form-item label="接入凭据"><el-input :model-value="created.credential" type="password" show-password readonly /><el-button class="copy-button" @click="copy(created.credential)">复制凭据</el-button></el-form-item>
              <el-form-item label="独立节点接入配置"><el-input :model-value="created.connection.env" type="textarea" :rows="8" readonly /></el-form-item>
            </el-form>
            <div class="card-actions"><el-button @click="copy(created.connection.env, true)">复制接入配置</el-button><el-button @click="downloadConfig">下载接入配置</el-button></div>
          </el-collapse-item>
        </el-collapse>
      </template>
      <template #footer><el-button @click="refresh()">刷新状态</el-button><el-button @click="beforeCloseCredential(() => credentialVisible = false)">{{ currentNode?.ready ? '完成' : '关闭窗口' }}</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminFeatureRequest } from '@/request/features.js'
import { copyText } from '@/utils/copy-text.js'
import { useFeatureResource } from '@/composables/use-feature-resource.js'
import { useFeaturePolling } from '@/composables/use-feature-polling.js'
import '@/views/links/features.css'

const query = reactive({ page: 1, pageSize: 20 })
const { data, loading, error, refresh, cancel } = useFeatureResource(signal => adminFeatureRequest('/admin/nodes', { query, signal }))
const busyId = ref(''), createVisible = ref(false), name = ref(''), creating = ref(false), createError = ref('')
const created = ref(null), credentialVisible = ref(false), savedCredential = ref(false)
const createSections = ref([]), credentialSections = ref([]), optionsLoading = ref(false), optionsError = ref(''), bundleAvailable = ref(false)
const bundleFormat = ref('source'), installationClock = ref(Date.now())
const deployment = reactive({ primaryUrl: `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, ''), port: 3001, allowInsecureHttp: false })
const usesHttp = computed(() => /^http:\/\//i.test(deployment.primaryUrl.trim()))
function isLocalPrimaryAddress(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || ['0.0.0.0', '[::1]', '[::]'].includes(host)
}
const localPrimaryAddress = computed(() => {
  try { return isLocalPrimaryAddress(new URL(deployment.primaryUrl.trim())) } catch { return false }
})
const currentNode = computed(() => data.value?.items.find(node => node.id === created.value?.node?.id) || created.value?.node)
const installationCommand = computed(() => created.value?.deployment?.command || '')
const installerUrl = computed(() => created.value?.deployment?.installerUrl || '')
const installationExpired = computed(() => {
  const deadline = Date.parse(created.value?.deployment?.expiresAt || '')
  return Number.isFinite(deadline) && installationClock.value >= deadline
})
const installationUnavailable = computed(() => installationExpired.value || !!currentNode.value?.revoked || !!currentNode.value?.disabled)
const deploymentStatus = computed(() => {
  const node = currentNode.value
  if (node?.ready) return { type: 'success', label: '部署完成', title: '节点已就绪，可以取信', description: `已连接主节点，配置同步完成${node.ip ? `，连接 IP：${node.ip}` : ''}。` }
  if (node?.revoked || node?.disabled) return { type: 'warning', label: '接入已停止', title: node.revoked ? '节点已被永久撤销' : '节点已停用', description: node.revoked ? '原部署命令和凭据已失效，请创建新节点。' : '原部署命令已失效。已安装的节点恢复接入后会自动重连；尚未安装时，请创建新节点。' }
  if (node?.online) return { type: 'info', label: '正在同步', title: '服务器已连接，正在同步配置', description: '首次同步完成后会自动显示部署成功，页面每 5 秒更新。' }
  if (node?.lastHeartbeatAt) return { type: 'warning', label: '连接中断', title: '节点与主节点的连接已中断', description: '请检查目标服务器上的容器运行状态、网络及主节点地址，连接恢复后会自动继续同步。' }
  if (installationExpired.value) return { type: 'warning', label: '安装参数已过期', title: '本次安装参数已过期', description: '请重新新增节点并获取有效安装参数；已经开始安装时，可先查看服务器终端和容器运行状态。' }
  return { type: 'info', label: '等待连接', title: '等待目标服务器执行安装命令', description: `${created.value?.deployment?.format === 'docker-image' ? '安装包下载和导入' : '首次构建镜像'}可能需要几分钟，请保持终端运行；连接成功后会在这里显示进度。` }
})
const stateLabel = status => ({ revoked: '已永久撤销', disabled: '已停用', initializing: '首次同步中', online: '在线', offline: '未连接 / 离线' }[status] || status)
const stateType = status => ({ revoked: 'danger', disabled: 'warning', initializing: 'primary', online: 'success', offline: 'info' }[status] || 'info')
const formatTime = value => value ? new Date(value).toLocaleString() : '—'
function pageSizeChanged() { query.page = 1; refresh() }
async function loadDeploymentOptions() {
  optionsLoading.value = true; optionsError.value = ''; bundleAvailable.value = false
  try {
    const options = await adminFeatureRequest('/admin/nodes/deployment-options')
    if (options.primaryUrl) deployment.primaryUrl = options.primaryUrl
    if (localPrimaryAddress.value) createSections.value = ['settings']
    bundleAvailable.value = options.bundleAvailable === true
    bundleFormat.value = options.bundleFormat === 'docker-image' ? 'docker-image' : 'source'
  } catch (cause) { optionsError.value = cause.message || '部署设置加载失败，请重试' }
  finally { optionsLoading.value = false }
}
function openCreate() {
  name.value = ''; createError.value = ''; createSections.value = localPrimaryAddress.value ? ['settings'] : []; deployment.port = 3001; deployment.allowInsecureHttp = false; createVisible.value = true
  loadDeploymentOptions()
}
async function create() {
  if (creating.value || optionsLoading.value || !bundleAvailable.value || optionsError.value) return
  if (!name.value.trim()) { createError.value = '请输入节点名称'; return }
  let primaryUrl
  try {
    primaryUrl = new URL(deployment.primaryUrl.trim())
    if (!['https:', 'http:'].includes(primaryUrl.protocol) || primaryUrl.username || primaryUrl.password || primaryUrl.search || primaryUrl.hash) throw new Error()
  } catch { createError.value = '请输入有效的 HTTP 或 HTTPS 主节点地址'; createSections.value = ['settings']; return }
  if (isLocalPrimaryAddress(primaryUrl)) { createError.value = '请填写目标 Docker 容器能够访问的主节点局域网 IP 或域名'; createSections.value = ['settings']; return }
  if (!Number.isInteger(deployment.port) || deployment.port < 1 || deployment.port > 65535) { createError.value = '请输入 1 到 65535 之间的访问端口'; createSections.value = ['settings']; return }
  if (usesHttp.value && !deployment.allowInsecureHttp) { createError.value = '使用 HTTP 时，请确认仅通过受信局域网连接'; return }
  creating.value = true; createError.value = ''
  try {
    created.value = await adminFeatureRequest('/admin/nodes', { method: 'POST', data: { name: name.value.trim(), deployment: { primaryUrl: primaryUrl.href.replace(/\/+$/, ''), port: deployment.port, allowInsecureHttp: usesHttp.value && deployment.allowInsecureHttp } } })
    createVisible.value = false; savedCredential.value = false; credentialSections.value = []; installationClock.value = Date.now(); credentialVisible.value = true; query.page = 1; await refresh()
  } catch (cause) { createError.value = cause.message } finally { creating.value = false }
}
async function beforeCloseCredential(done) {
  if (!savedCredential.value && !currentNode.value?.ready) {
    try { await ElMessageBox.confirm('该节点的安装参数和接入配置只在本次新增后提供。尚未复制带参数的安装命令或保存配置，确认关闭？', '安装命令尚未保存', { type: 'warning', confirmButtonText: '关闭', cancelButtonText: '继续安装' }) }
    catch { return }
  }
  done()
}
function clearCredential() { created.value = null; savedCredential.value = false }
async function copy(value, save = false) {
  if (typeof value !== 'string' || !value) { ElMessage.error('没有可复制的内容'); return }
  try { await copyText(value); if (save) savedCredential.value = true; ElMessage.success('已复制') }
  catch (cause) { ElMessage.error(cause.message) }
}
function copyInstallation(value) {
  installationClock.value = Date.now()
  if (installationUnavailable.value) { ElMessage.warning('本次安装参数已失效，请重新新增节点获取有效参数'); return }
  return copy(value, true)
}
function downloadText(value, filename, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([value], { type }))
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  savedCredential.value = true
}
function downloadConfig() { if (created.value?.connection?.env) downloadText(created.value.connection.env, created.value.connection.filename) }
async function action(node, title, text, path, options) {
  try {
    await ElMessageBox.confirm(text, title, { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' })
    busyId.value = node.id
    await adminFeatureRequest(path, options); await refresh(); ElMessage.success('节点状态已更新')
  } catch (cause) { if (cause instanceof Error) ElMessage.error(cause.message) } finally { busyId.value = '' }
}
function changeStatus(node) { return action(node, node.disabled ? '恢复节点接入' : '停用节点接入', node.disabled ? `恢复 ${node.name} 的原凭据。运行中的子节点将在重新连接并追平配置后恢复取信，不会自动启动已关闭的服务器。` : `停用 ${node.name} 后将拒绝后续接入并停止该节点取信；原凭据和同步进度保留，可稍后恢复。`, `/admin/nodes/${encodeURIComponent(node.id)}/status`, { method: 'PUT', data: { disabled: !node.disabled } }) }
function revoke(node) { return action(node, '永久撤销节点', `永久撤销 ${node.name} 的接入凭据，原凭据无法恢复。需要重新接入时必须创建新节点。确认继续？`, `/admin/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' }) }
function removeRecord(node) { return action(node, '删除已撤销记录', `从列表删除 ${node.name} 的撤销记录；旧凭据仍永久失效，不会恢复其接入权限。确认删除？`, `/admin/nodes/${encodeURIComponent(node.id)}/record`, { method: 'DELETE' }) }
useFeaturePolling(() => { installationClock.value = Date.now(); return refresh({ quiet: true }) }, { cancel })
refresh()
</script>

<style scoped>
.node-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
.node-stats article { border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 16px; }
.node-stats span { display: block; font-size: 12px; color: var(--el-text-color-secondary); }
.node-stats strong { display: block; font-size: 25px; margin-top: 5px; }
.node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr)); gap: 18px; }
.node-card { border: 1px solid var(--el-border-color-light); padding: 20px; border-radius: 12px; min-width: 0; }
.node-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.node-heading h2 { font-size: 17px; margin: 0 0 5px; overflow-wrap: anywhere; }
.node-heading code { font-size: 11px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.ready-line { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; align-items: center; font-size: 12px; color: var(--el-text-color-secondary); }
.snapshot { margin: 14px 0; }.snapshot > div:first-child { display: flex; justify-content: space-between; font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 7px; }
.node-error { color: var(--el-color-danger); font-size: 12px; overflow-wrap: anywhere; margin: 14px 0; }
.poll-note { color: var(--el-text-color-secondary); font-size: 12px; align-self: center; }.copy-button { margin-top: 8px; }
.deploy-intro { margin: 0 0 20px; color: var(--el-text-color-regular); line-height: 1.7; }
.deploy-advanced { margin-top: 18px; }.deploy-advanced :deep(.el-collapse-item__header) { font-weight: 500; }
.http-consent { margin: 16px 0; }.http-consent :deep(.el-checkbox) { white-space: normal; height: auto; align-items: flex-start; }.http-consent :deep(.el-checkbox__label) { white-space: normal; }
.deploy-node-name { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }.deploy-node-name strong { overflow-wrap: anywhere; font-size: 18px; }
.script-created { margin-bottom: 20px; }.installer-link { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.command-box { border: 1px solid var(--el-border-color); background: var(--el-fill-color-light); border-radius: 10px; padding: 16px; }.command-box pre { margin: 0; font: 13px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
.deploy-command-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }.deploy-command-actions :deep(.el-button + .el-button) { margin-left: 0; }
.deployment-progress { margin-top: 22px; }.deployment-progress :deep(.el-progress) { margin-top: 14px; }
@media (max-width: 600px) { .node-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }.node-card { padding: 16px; } }
</style>
