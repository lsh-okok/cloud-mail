<template>
  <section class="redemption-order">
    <header class="order-heading">
      <div><h2>{{ order.orderNo }}</h2><p>{{ redemptionTime(order.createdAt) }} · {{ order.batch ? '批量兑换' : '单码兑换' }}</p></div>
      <el-tag :type="orderStatusType(order.status)">{{ orderStatusLabel(order.status) }}</el-tag>
    </header>
    <div class="order-summary">
      <span>成功 <strong>{{ order.successCount || 0 }}</strong> 个主邮箱</span>
      <span>失败 <strong>{{ order.failureCount || 0 }}</strong> 个码</span>
      <span>子邮箱 <strong>{{ order.childCount || 0 }}</strong></span>
      <span>链接 <strong>{{ order.linkCount || 0 }}</strong></span>
    </div>
    <div v-if="order.file" class="order-file">
      <div><strong>{{ order.file.filename }}</strong><p>{{ order.batch ? 'ZIP 压缩包 · 每个主邮箱一份 TXT' : 'TXT 文件' }} · {{ redemptionFileSize(order.file.size) }}</p></div>
      <el-button type="primary" :loading="downloading" :disabled="downloadDisabled" @click="$emit('download')">下载{{ order.batch ? ' ZIP' : ' TXT' }}</el-button>
    </div>
    <el-alert v-else title="本次没有成功交付的文件，失败的兑换码未被消耗。" type="info" :closable="false" />
    <el-table :data="order.items || []" row-key="index" class="order-items" max-height="520">
      <el-table-column type="expand" width="42"><template #default="{ row }">
        <div class="link-details">
          <el-table v-if="row.ok && row.links?.length" :data="row.links" max-height="320" size="small">
            <el-table-column prop="recipient" label="子邮箱" min-width="210" show-overflow-tooltip />
            <el-table-column label="取码链接" min-width="200"><template #default="{ row: link }"><a v-if="safeUrl(link.url)" :href="safeUrl(link.url)" target="_blank" rel="noopener noreferrer">打开取码链接</a><span v-else>链接不可用</span></template></el-table-column>
            <el-table-column prop="platformName" label="平台" min-width="130" />
            <el-table-column label="有效期" min-width="190"><template #default="{ row: link }"><span :class="{ expired: isExpired(link.expiresAt) }">{{ link.expiresAt ? `${redemptionTime(link.expiresAt)}${isExpired(link.expiresAt) ? '（已过期）' : ''}` : '长期' }}</span></template></el-table-column>
          </el-table>
          <p v-else>{{ row.ok ? '完整子邮箱与链接请下载文件查看。' : row.error?.message || '本项未成功兑换' }}</p>
        </div>
      </template></el-table-column>
      <el-table-column label="序号" width="66"><template #default="{ row }">{{ row.index + 1 }}</template></el-table-column>
      <el-table-column label="主邮箱" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ row.mailboxEmail || '—' }}</template></el-table-column>
      <el-table-column label="结果" min-width="220"><template #default="{ row }"><el-tag v-if="row.ok" type="success">核销成功</el-tag><span v-else class="failure-reason">{{ row.error?.message || cardStatusLabel(row.codeStatus) || '兑换失败' }}</span></template></el-table-column>
      <el-table-column label="子邮箱 / 链接" width="130"><template #default="{ row }">{{ row.ok ? `${row.childCount || 0} / ${row.linkCount || 0}` : '—' }}</template></el-table-column>
    </el-table>
    <p v-if="order.file" class="order-note">文件保留本次交付内容。链接按各自有效期使用，重新下载不会延长期限。</p>
  </section>
</template>

<script setup>
import { cardStatusLabel, orderStatusLabel, orderStatusType, redemptionTime, redemptionFileSize } from '@/utils/redemption.js'
defineProps({ order: { type: Object, required: true }, downloading: Boolean, downloadDisabled: Boolean })
defineEmits(['download'])
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : '' } catch { return '' }
}
function isExpired(value) { return value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() }
</script>

<style scoped>
.redemption-order { min-width: 0; }
.order-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.order-heading h2 { margin: 0 0 7px; font-size: 17px; overflow-wrap: anywhere; }
.order-heading p, .order-file p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.order-summary { display: flex; gap: 12px 24px; flex-wrap: wrap; margin: 19px 0; color: var(--el-text-color-regular); font-size: 13px; }
.order-summary strong { color: var(--el-text-color-primary); }
.order-file { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px; margin-bottom: 16px; background: var(--el-fill-color-light); border-radius: 10px; }
.order-file strong { font-size: 13px; overflow-wrap: anywhere; }
.order-file p { margin-top: 5px; }
.order-note { font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); margin: 14px 0 0; }
.link-details { padding: 12px 20px; }
.link-details p { color: var(--el-text-color-secondary); font-size: 13px; }
.link-details a { color: var(--el-color-primary); text-decoration: none; }
.failure-reason, .expired { color: var(--el-color-danger); }
@media (max-width: 600px) { .order-file { align-items: stretch; flex-direction: column; } .order-file .el-button { align-self: flex-start; } .link-details { padding: 8px; } }
</style>
