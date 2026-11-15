<template>
  <el-form-item label="检测主邮箱范围"><MailboxPicker v-model="options.mailboxIds" :disabled="disabled" /></el-form-item>
  <el-form-item label="每个主邮箱的子地址抽样"><el-select v-model="options.sample" :disabled="disabled" style="width:100%"><el-option label="全部子地址" value="all" /><el-option v-for="value in [1, 3, 5]" :key="value" :label="`每主邮箱抽取 ${value} 个`" :value="value" /></el-select></el-form-item>
  <div class="option-grid">
    <el-form-item label="单次请求超时（秒）"><el-input-number v-model="options.timeoutSeconds" :disabled="disabled" :min="1" :max="60" :precision="0" /></el-form-item>
    <el-form-item label="并行检测数"><el-input-number v-model="options.concurrency" :disabled="disabled" :min="1" :max="10" :precision="0" /></el-form-item>
    <template v-if="receive"><el-form-item label="等待收信（秒）"><el-input-number v-model="options.waitSeconds" :disabled="disabled" :min="5" :max="300" :precision="0" /></el-form-item><el-form-item label="发信间隔（毫秒）"><el-input-number v-model="options.sendIntervalMs" :disabled="disabled" :min="200" :max="10000" :step="100" :precision="0" /></el-form-item></template>
  </div>
</template>
<script setup>
import MailboxPicker from './mailbox-picker.vue'
defineProps({ options: { type: Object, required: true }, receive: Boolean, disabled: Boolean })
</script>
<style scoped>.option-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px; }.option-grid .el-input-number{width:100%}@media(max-width:480px){.option-grid{grid-template-columns:1fr}}</style>
