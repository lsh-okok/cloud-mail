#!/bin/sh
set -eu
cert_fingerprint() {
    cat "$SMTP_TLS_CERT_FILE" "$SMTP_TLS_KEY_FILE" 2>/dev/null | sha256sum | cut -d ' ' -f 1
}
last_cert=$(cert_fingerprint)
log_limit=${MAIL_LOG_MAX_BYTES:-104857600}
log_keep=${MAIL_LOG_KEEP:-7}
case "$log_limit:$log_keep" in *[!0-9:]*|:|*:0) echo 'Invalid mail log rotation settings' >&2; exit 1;; esac
while :; do
    sleep 30
    current_cert=$(cert_fingerprint)
    if [ "$current_cert" != "$last_cert" ]; then
        cert_key=$(openssl x509 -in "$SMTP_TLS_CERT_FILE" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)
        private_key=$(openssl pkey -in "$SMTP_TLS_KEY_FILE" -pubout -outform DER 2>/dev/null | sha256sum)
        if openssl x509 -in "$SMTP_TLS_CERT_FILE" -checkend 0 -noout >/dev/null 2>&1 \
            && openssl x509 -in "$SMTP_TLS_CERT_FILE" -checkhost "$MAIL_HOST" -noout >/dev/null 2>&1 \
            && openssl pkey -in "$SMTP_TLS_KEY_FILE" -noout >/dev/null 2>&1 \
            && [ "$cert_key" = "$private_key" ]; then
            postfix reload
            last_cert=$current_cert
            echo 'Reloaded Postfix after an NPM certificate change'
        fi
    fi
    if [ -f /var/log/postfix/postfix.log ]; then
        size=$(wc -c < /var/log/postfix/postfix.log)
        if [ "$size" -ge "$log_limit" ]; then
            postfix logrotate
            touch /var/log/postfix/postfix.log
            chmod 644 /var/log/postfix/postfix.log
            # Rotation filenames use sortable timestamps; only generated archives match.
            ls -1t /var/log/postfix/postfix.log.[0-9]* 2>/dev/null | tail -n "+$((log_keep + 1))" | while IFS= read -r old_log; do
                rm -f -- "$old_log"
            done
        fi
    fi
done
