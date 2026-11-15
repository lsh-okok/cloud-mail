#!/bin/sh
set -eu
umask 027

: "${MAIL_HOST:?MAIL_HOST is required}"
: "${MAIL_DOMAINS:?MAIL_DOMAINS is required}"
: "${SMTP_TLS_CERT_FILE:?SMTP_TLS_CERT_FILE is required}"
: "${SMTP_TLS_KEY_FILE:?SMTP_TLS_KEY_FILE is required}"
DKIM_SELECTOR=${DKIM_SELECTOR:-mail}
MAIL_NETWORK_SUBNET=${MAIL_NETWORK_SUBNET:-172.30.89.0/24}
MAX_MESSAGE_BYTES=${MAX_MESSAGE_BYTES:-26214400}

# Restrict values before writing Postfix/OpenDKIM configuration files.
case "$MAIL_HOST" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid MAIL_HOST' >&2; exit 1;; esac
case "$DKIM_SELECTOR" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid DKIM_SELECTOR' >&2; exit 1;; esac
case "$MAIL_NETWORK_SUBNET" in *[!0-9./]*|'') echo 'Invalid MAIL_NETWORK_SUBNET' >&2; exit 1;; esac
case "$MAX_MESSAGE_BYTES" in *[!0-9]*|'') echo 'Invalid MAX_MESSAGE_BYTES' >&2; exit 1;; esac
test -r "$SMTP_TLS_CERT_FILE" && test -r "$SMTP_TLS_KEY_FILE" || {
    echo 'NPM certificate/key not readable. Mount the complete letsencrypt directory and configure SMTP_TLS_*_FILE.' >&2
    exit 1
}
openssl x509 -in "$SMTP_TLS_CERT_FILE" -noout -checkend 0 >/dev/null
openssl x509 -in "$SMTP_TLS_CERT_FILE" -noout -checkhost "$MAIL_HOST" >/dev/null
cert_key=$(openssl x509 -in "$SMTP_TLS_CERT_FILE" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
private_key=$(openssl pkey -in "$SMTP_TLS_KEY_FILE" -pubout -outform DER | sha256sum)
test "$cert_key" = "$private_key" || { echo 'TLS certificate and key do not match' >&2; exit 1; }

mkdir -p /run/opendkim /var/log/postfix /etc/opendkim/keys
touch /var/log/postfix/postfix.log
chmod 755 /var/log/postfix
chmod 644 /var/log/postfix/postfix.log
chown opendkim:opendkim /run/opendkim
chmod 750 /etc/opendkim
chown root:opendkim /etc/opendkim
chmod 750 /etc/opendkim/keys
chown root:opendkim /etc/opendkim/keys

: > /etc/opendkim/KeyTable
: > /etc/opendkim/SigningTable
domain_list=''
old_ifs=$IFS
IFS=,
for domain in $MAIL_DOMAINS; do
    IFS=$old_ifs
    domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    case "$domain" in *[!a-z0-9.-]*|''|.*|*.) echo 'Invalid domain in MAIL_DOMAINS' >&2; exit 1;; esac
    case "$domain" in *.*) ;; *) echo 'MAIL_DOMAINS requires full domain names' >&2; exit 1;; esac
    key_dir="/etc/opendkim/keys/$domain"
    mkdir -p "$key_dir"
    if [ ! -s "$key_dir/$DKIM_SELECTOR.private" ]; then
        opendkim-genkey -b 2048 -D "$key_dir" -d "$domain" -s "$DKIM_SELECTOR"
        echo "Generated DKIM key for $domain. Publish $DKIM_SELECTOR._domainkey.$domain from $key_dir/$DKIM_SELECTOR.txt"
    fi
    chown -R opendkim:opendkim "$key_dir"
    chmod 750 "$key_dir"
    chmod 600 "$key_dir/$DKIM_SELECTOR.private"
    chmod 644 "$key_dir/$DKIM_SELECTOR.txt"
    printf '%s._domainkey.%s %s:%s:%s/%s.private\n' "$DKIM_SELECTOR" "$domain" "$domain" "$DKIM_SELECTOR" "$key_dir" "$DKIM_SELECTOR" >> /etc/opendkim/KeyTable
    printf '*@%s %s._domainkey.%s\n' "$domain" "$DKIM_SELECTOR" "$domain" >> /etc/opendkim/SigningTable
    domain_list="${domain_list}${domain_list:+, }$domain"
    IFS=,
done
IFS=$old_ifs

cat > /etc/opendkim.conf <<EOF
Syslog yes
SyslogSuccess yes
LogWhy yes
UMask 007
UserID opendkim:opendkim
Socket inet:8891@127.0.0.1
PidFile /run/opendkim/opendkim.pid
Mode s
Canonicalization relaxed/simple
OversignHeaders From
RequireSafeKeys yes
KeyTable /etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
InternalHosts /etc/opendkim/TrustedHosts
EOF
printf '127.0.0.1\n::1\n%s\n' "$MAIL_NETWORK_SUBNET" > /etc/opendkim/TrustedHosts
chmod 640 /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts
chown root:opendkim /etc/opendkim/KeyTable /etc/opendkim/SigningTable /etc/opendkim/TrustedHosts

postconf -e "myhostname = $MAIL_HOST"
postconf -e 'myorigin = $myhostname'
postconf -e 'mydestination = localhost'
postconf -e 'inet_interfaces = all'
postconf -e 'inet_protocols = ipv4'
postconf -e "mynetworks = 127.0.0.0/8, $MAIL_NETWORK_SUBNET"
postconf -e "virtual_mailbox_domains = $domain_list"
postconf -e 'virtual_transport = lmtp:inet:app:2525'
postconf -e 'local_transport = error:local delivery disabled'
postconf -e 'relay_domains ='
postconf -e 'relayhost ='
postconf -e 'smtpd_relay_restrictions = reject_unauth_destination'
postconf -e 'smtpd_recipient_restrictions = reject_unauth_destination, check_policy_service inet:app:10040'
postconf -e 'smtpd_reject_unlisted_recipient = no'
postconf -e 'smtpd_policy_service_default_action = 451 4.3.0 Recipient service temporarily unavailable'
postconf -e 'smtpd_policy_service_timeout = 10s'
postconf -e 'smtpd_helo_required = yes'
postconf -e 'disable_vrfy_command = yes'
postconf -e "message_size_limit = $MAX_MESSAGE_BYTES"
postconf -e 'mailbox_size_limit = 0'
postconf -e 'enable_long_queue_ids = yes'
postconf -e 'maillog_file = /var/log/postfix/postfix.log'
postconf -e 'maillog_file_rotate_suffix = %Y%m%d-%H%M%S'
# This parameter requires a non-empty command. A no-op preserves the rotated
# file and inode so the application can drain pending delivery log records.
postconf -e 'maillog_file_compressor = /bin/true'
postconf -e 'smtpd_tls_security_level = may'
postconf -e "smtpd_tls_cert_file = $SMTP_TLS_CERT_FILE"
postconf -e "smtpd_tls_key_file = $SMTP_TLS_KEY_FILE"
postconf -e 'smtpd_tls_protocols = >=TLSv1.2'
postconf -e 'smtpd_tls_mandatory_protocols = >=TLSv1.2'
postconf -e 'smtp_tls_security_level = may'
postconf -e 'smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt'
postconf -e 'smtp_tls_loglevel = 1'
postconf -e 'smtpd_milters ='
postconf -e 'non_smtpd_milters ='
postconf -e 'milter_default_action = tempfail'
postconf -e 'milter_protocol = 6'
postconf -e 'biff = no'
postconf -e 'append_dot_mydomain = no'
postconf -e 'readme_directory = no'

# Public SMTP never trusts mynetworks for relaying. Only this un-published
# submission listener accepts relaying from the isolated Compose mail subnet.
cat > /etc/postfix/master.cf <<'EOF'
smtp      inet  n       -       n       -       -       smtpd
submission inet n       -       n       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_client_restrictions=permit_mynetworks,reject
  -o smtpd_relay_restrictions=permit_mynetworks,reject
  -o smtpd_recipient_restrictions=permit_mynetworks,reject
  -o smtpd_tls_security_level=none
  -o smtpd_milters=inet:127.0.0.1:8891
  -o milter_macro_daemon_name=ORIGINATING
pickup    unix  n       -       n       60      1       pickup
cleanup   unix  n       -       n       -       0       cleanup
qmgr      unix  n       -       n       300     1       qmgr
tlsmgr    unix  -       -       n       1000?   1       tlsmgr
rewrite   unix  -       -       n       -       -       trivial-rewrite
bounce    unix  -       -       n       -       0       bounce
defer     unix  -       -       n       -       0       bounce
trace     unix  -       -       n       -       0       bounce
verify    unix  -       -       n       -       1       verify
flush     unix  n       -       n       1000?   0       flush
proxymap  unix  -       -       n       -       -       proxymap
proxywrite unix -       -       n       -       1       proxymap
smtp      unix  -       -       n       -       -       smtp
relay     unix  -       -       n       -       -       smtp
showq     unix  n       -       n       -       -       showq
error     unix  -       -       n       -       -       error
retry     unix  -       -       n       -       -       error
discard   unix  -       -       n       -       -       discard
local     unix  -       n       n       -       -       local
virtual   unix  -       n       n       -       -       virtual
lmtp      unix  -       -       n       -       -       lmtp
anvil     unix  -       -       n       -       1       anvil
scache    unix  -       -       n       -       1       scache
postlog   unix-dgram n  -       n       -       1       postlogd
EOF
# Debian installs package ownership/modes during image construction. The check
# command creates missing queue directories with their required ownership.
# set-permissions also requires optional manpages removed by the slim base image.
postfix check
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/mail.conf
