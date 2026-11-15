<template>
  <iframe v-if="html" class="safe-mail-body" :srcdoc="documentHtml" sandbox="" referrerpolicy="no-referrer" title="邮件正文" />
  <pre v-else class="plain-mail-body">{{ text || '（邮件没有正文）' }}</pre>
</template>

<script setup>
import { computed } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps({ html: { type: String, default: '' }, text: { type: String, default: '' } })
const documentHtml = computed(() => {
  const clean = DOMPurify.sanitize(props.html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'style', 'img', 'video', 'audio', 'source', 'track'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'href', 'action', 'formaction', 'background', 'ping', 'poster', 'target'],
  })
  // The iframe is a separate opaque origin; no script, forms, or network resources are allowed.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; img-src 'none'; font-src 'none'; connect-src 'none'"><meta name="referrer" content="no-referrer"><style>body{font:15px/1.65 system-ui,sans-serif;color:#202735;background:#fff;overflow-wrap:anywhere;margin:20px}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${clean}</body></html>`
})
</script>

<style scoped>
.safe-mail-body { display: block; width: 100%; min-height: 430px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: white; }
.plain-mail-body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; line-height: 1.7; font: inherit; }
</style>
