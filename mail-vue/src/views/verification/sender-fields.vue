<template>
  <el-form-item v-if="presets.length" label="常见服务预设"><el-select v-model="preset" clearable placeholder="手动填写或选择预设" :disabled="disabled" style="width:100%" @change="applyPreset"><el-option v-for="item in presets" :key="item.name" :value="item.name" :label="item.name" /></el-select><div v-if="presetHelp" class="sender-help">{{presetHelp}}</div></el-form-item>
  <el-form-item label="SMTP 主机"><el-input v-model="form.host" :disabled="disabled" placeholder="smtp.example.com" autocomplete="off" /></el-form-item>
  <div class="smtp-pair"><el-form-item label="端口"><el-input-number v-model="form.port" :min="1" :max="65535" :precision="0" :disabled="disabled" style="width:100%" /></el-form-item><el-form-item label="加密方式"><el-select v-model="form.encryption" :disabled="disabled" style="width:100%"><el-option label="TLS（通常 465）" value="tls" /><el-option label="STARTTLS（通常 587）" value="starttls" /></el-select></el-form-item></div>
  <el-form-item label="发件邮箱"><el-input v-model="form.email" :disabled="disabled" placeholder="sender@example.com" type="email" autocomplete="off" /></el-form-item>
  <el-form-item :label="hasPassword ? '新授权码（留空保留已保存授权码）' : 'SMTP 授权码'"><el-input v-model="form.password" type="password" show-password :disabled="disabled || form.clearPassword" :placeholder="hasPassword ? '已保存；留空不修改' : '填写邮箱服务商提供的 SMTP 授权码'" autocomplete="new-password" /><div class="sender-help">只支持加密传输。SMTP 主机默认限公网；受控内网服务器须由部署配置明确允许。</div></el-form-item>
</template>
<script setup>
import {computed,ref} from 'vue'
const props=defineProps({form:{type:Object,required:true},presets:{type:Array,default:()=>[]},disabled:Boolean,hasPassword:Boolean})
const preset=ref(''),presetHelp=computed(()=>props.presets.find(item=>item.name===preset.value)?.help||'')
function applyPreset(name){const item=props.presets.find(value=>value.name===name);if(item)Object.assign(props.form,{host:item.host,port:item.port,encryption:item.encryption})}
</script>
<style scoped>.smtp-pair{display:grid;grid-template-columns:1fr 1.4fr;gap:16px}.sender-help{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin-top:7px}@media(max-width:440px){.smtp-pair{grid-template-columns:1fr;gap:0}}</style>
