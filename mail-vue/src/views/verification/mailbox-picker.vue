<template>
  <el-select :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" :multiple="multiple" filterable remote clearable :remote-method="search" :loading="loading" :disabled="disabled" placeholder="留空表示全部主邮箱；输入地址搜索" style="width:100%" @visible-change="value => value && search('')">
    <el-option v-for="item in options" :key="item.id" :label="item.email" :value="item.id" :disabled="!item.enabled" />
  </el-select>
  <p v-if="error" class="form-help picker-error">{{ error }} <el-button text size="small" @click="search('')">重试</el-button></p>
</template>
<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { adminFeatureRequest } from '@/request/features.js'
const props = defineProps({ modelValue: { type: [Array,String], default: () => [] }, multiple: {type:Boolean,default:true}, disabled: Boolean })
defineEmits(['update:modelValue'])
const options = ref([]), loading = ref(false), error = ref('')
let controller, sequence = 0
async function search(q = '') {
  const current = ++sequence
  controller?.abort(); controller = new AbortController(); loading.value = true
  try {
    const data = await adminFeatureRequest('/admin/mailboxes', { query: { q, page: 1, pageSize: 50 }, signal: controller.signal })
    if (current !== sequence) return
    const selected = Array.isArray(props.modelValue) ? props.modelValue : [props.modelValue]
    options.value = [...new Map([...options.value.filter(item => selected.includes(item.id)), ...data.items].map(item => [item.id, item])).values()]
    error.value = ''
  } catch (cause) { if (current === sequence && cause.name !== 'AbortError') error.value = cause.message }
  finally { if (current === sequence) loading.value = false }
}
onBeforeUnmount(() => { sequence++; controller?.abort() })
search()
</script>
<style scoped>.picker-error { color: var(--el-color-danger); }</style>
