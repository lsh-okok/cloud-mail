#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
mail_dir=/opt/cloud-mail-primary
mail_name=''
mail_npm=npm
mail_cert_root=''
mail_cert_name=''
mail_show_dkim=false
mail_original_args=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir|--name|--npm-container|--cert-root|--cert-name)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail "$1 缺少参数值。"
      case "$1" in
        --dir) mail_dir=$2 ;; --name) mail_name=$2 ;; --npm-container) mail_npm=$2 ;;
        --cert-root) mail_cert_root=$2 ;; --cert-name) mail_cert_name=$2 ;;
      esac
      shift 2 ;;
    --show-dkim) mail_show_dkim=true; shift ;;
    --help|-h)
      printf '%s\n' '用法：sudo bash enable-mail.sh [--dir /opt/cloud-mail-primary] [--name 容器名] [--npm-container npm] [--cert-root NPM证书根目录] [--cert-name npm-1]' \
        '为已安装的独立管理主节点启用公网25端口收信，保留现有应用、账号及邮件。' \
        '默认自动选择 NPM 中覆盖 MAIL_HOST 的有效证书；从 GHCR 拉取经过测试的邮件镜像。' \
        '仅查看可直接粘贴到 Cloudflare 的 DKIM 名称和内容：bash enable-mail.sh --show-dkim [--dir 安装目录]'
      exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done
[[ $(uname -s) == Linux ]] || fail '邮件启动脚本适用于 Linux 服务器。'
case "$(uname -m)" in x86_64|amd64) ;; *) fail '官方镜像仅支持 Linux amd64。' ;; esac
if [[ $(id -u) != 0 ]]; then exec sudo bash "$0" "${mail_original_args[@]}"; fi
mail_tools=(docker awk sed)
if [[ $mail_show_dkim == false ]]; then mail_tools+=(openssl ss sha256sum); fi
for mail_tool in "${mail_tools[@]}"; do command -v "$mail_tool" >/dev/null || fail "缺少工具：$mail_tool"; done
docker info >/dev/null 2>&1 || fail '无法连接 Docker 服务。'
[[ $mail_dir == /* && -d $mail_dir && ! -L $mail_dir ]] || fail '请指定已有主节点的安装目录。'
mail_dir=$(cd "$mail_dir" && pwd -P)
mail_state="$mail_dir/.install-state"
[[ -f $mail_state && ! -L $mail_state ]] || fail '缺少主节点安装记录，请先安装管理主节点。'
read_state() {
  [[ $(awk -v key="$1=" 'index($0,key)==1 {n++} END {print n+0}' "$mail_state") == 1 ]] || fail '主节点安装记录不完整。'
  sed -n "s/^$1=//p" "$mail_state"
}
[[ $(read_state INSTALL_DIR) == "$mail_dir" ]] || fail '安装目录与记录不一致。'
mail_app=$(read_state CONTAINER_NAME)
[[ -z $mail_name || $mail_name == "$mail_app" ]] || fail '容器名与安装记录不一致。'
[[ $mail_app =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || fail '安装记录中的容器名无效。'
mail_instance=$(read_state INSTANCE_ID)
[[ $mail_instance =~ ^[0-9a-f]{32}$ ]] || fail '安装身份无效。'
mail_data="$mail_app-data"
mail_app_mount=$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$mail_app")
[[ $mail_app_mount == "volume:$mail_data" ]] || fail '应用的数据挂载与安装记录不一致。'
[[ $(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$mail_data") == "$mail_instance" ]] || fail '应用数据卷不属于此安装。'
[[ $(docker container inspect --format '{{.State.Running}}' "$mail_app") == true ]] || fail '请先启动管理主节点。'
app_setting() { docker exec "$mail_app" node -p 'process.env[process.argv[1]] || ""' "$1"; }
[[ $(app_setting NODE_ROLE) == primary ]] || fail '只能为管理主节点启用收信。'
mail_domains=$(app_setting MAIL_DOMAINS)
[[ $mail_domains =~ ^[a-zA-Z0-9][a-zA-Z0-9.,-]*$ ]] || fail '应用 MAIL_DOMAINS 无效。'
mail_gateway="$mail_app-mail"
mail_existing=false
if docker container inspect "$mail_gateway" >/dev/null 2>&1; then
  [[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.installation-id"}}' "$mail_gateway") == "$mail_instance" ]] || fail '同名邮件容器属于其他安装。'
  [[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.role"}}' "$mail_gateway") == mta ]] || fail '同名容器不是本实例的邮件服务。'
  mail_existing=true
fi

show_dkim() {
  local mail_domain mail_raw mail_txt
  local -a mail_domain_list
  printf '%s\n' 'Cloudflare DNS：每个域名添加一条 TXT 记录，将“内容”下方整行直接粘贴到内容框。'
  IFS=, read -r -a mail_domain_list <<< "$mail_domains"
  for mail_domain in "${mail_domain_list[@]}"; do
    mail_raw=$(docker exec "$mail_gateway" cat "/etc/opendkim/keys/$mail_domain/mail.txt") || fail "无法读取 $mail_domain 的 DKIM 公钥，请确认邮件容器已启动且密钥已生成。"
    # OpenDKIM wraps long TXT values in quoted fragments; semicolons inside
    # quotes are DKIM tags, while semicolons outside quotes start zone comments.
    mail_txt=$(LC_ALL=C awk '
      {
        sub(/\r$/, "")
        for (i=1; i<=length($0); i++) {
          c=substr($0,i,1)
          if (quoted) {
            if (c=="\"") quoted=0
            else if (c=="\\") invalid=1
            else value=value c
          } else if (c==";") break
          else if (c=="\"") quoted=1
        }
        if (quoted) invalid=1
      }
      END {
        sub(/^[ \t]+/, "", value); sub(/[ \t]+$/, "", value)
        if (invalid || value !~ /^v=DKIM1;/ || value ~ /[^ -~]/) exit 1
        n=split(value,tags,";")
        for (i=1; i<=n; i++) {
          sub(/^[ \t]+/, "", tags[i]); sub(/[ \t]+$/, "", tags[i])
          if (tags[i] ~ /^p=/) {
            key=substr(tags[i],3); keys++
            if (key !~ /^[A-Za-z0-9+\/]+=?=?$/) exit 1
          }
        }
        if (keys!=1) exit 1
        print value
      }
    ' <<< "$mail_raw") || fail "$mail_domain 的 DKIM 公钥格式无效，未输出不完整的 DNS 内容。"
    printf '\n域名：%s\n类型：TXT\n名称：mail._domainkey\n完整名称：mail._domainkey.%s\n内容：\n%s\n' "$mail_domain" "$mail_domain" "$mail_txt"
  done
}

if [[ $mail_show_dkim == true ]]; then
  [[ $mail_existing == true ]] || fail '尚未找到本实例的邮件容器，请先启用公网收信。'
  show_dkim
  exit 0
fi

mail_host=$(app_setting MAIL_HOST)
mail_subnet=$(app_setting MAIL_NETWORK_SUBNET)
mail_subnet=${mail_subnet:-172.30.89.0/24}
[[ $mail_host =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+$ ]] || fail '应用 MAIL_HOST 无效。'
[[ $mail_subnet =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$ ]] || fail 'MAIL_NETWORK_SUBNET 必须是 IPv4 网段。'

if [[ -z $mail_cert_root ]]; then
  mail_cert_root=$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/letsencrypt"}}{{.Source}}{{end}}{{end}}' "$mail_npm")
fi
[[ $mail_cert_root == /* && -d $mail_cert_root ]] || fail '未找到 NPM 证书目录，请用 --cert-root 指定完整 letsencrypt 目录。'
mail_cert_root=$(cd "$mail_cert_root" && pwd -P)
if [[ -n $mail_cert_name ]]; then
  [[ $mail_cert_name =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $mail_cert_name != *..* ]] || fail '证书名称无效。'
  mail_candidates=("$mail_cert_root/live/$mail_cert_name/fullchain.pem")
else
  mail_candidates=("$mail_cert_root"/live/*/fullchain.pem)
fi
mail_cert=''
for mail_candidate in "${mail_candidates[@]}"; do
  [[ -f $mail_candidate && -f ${mail_candidate%/*}/privkey.pem ]] || continue
  if openssl x509 -in "$mail_candidate" -noout -checkend 0 -checkhost "$mail_host" >/dev/null 2>&1; then
    mail_public_key=$(openssl x509 -in "$mail_candidate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
    mail_private_key=$(openssl pkey -in "${mail_candidate%/*}/privkey.pem" -pubout -outform DER | sha256sum)
    if [[ $mail_public_key == "$mail_private_key" ]]; then mail_cert=$mail_candidate; break; fi
  fi
done
[[ -n $mail_cert ]] || fail "请先在 NPM 为 $mail_host 申请有效的 Let's Encrypt 证书，再执行本命令。"
mail_cert_relative=${mail_cert#"$mail_cert_root/"}
mail_network="$mail_app-mail-network"
mail_volumes=("$mail_app-mail-spool" "$mail_app-dkim" "$mail_app-mail-logs")
if [[ -n $(ss -H -ltn 'sport = :25') ]]; then
  [[ $mail_existing == true ]] || fail '25端口已被其他服务占用，已停止。'
  mail_ports=$(docker container inspect --format '{{range (index .HostConfig.PortBindings "25/tcp")}}{{println .HostPort}}{{end}}' "$mail_gateway")
  [[ $mail_ports == 25 ]] || fail '25端口不属于本实例的邮件容器。'
fi
mail_network_exists=false
if docker network inspect "$mail_network" >/dev/null 2>&1; then
  [[ $(docker network inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$mail_network") == "$mail_instance" ]] || fail '同名邮件网络属于其他安装。'
  [[ $(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$mail_network") == "$mail_subnet" ]] || fail '邮件网络与应用信任网段不一致。'
  mail_peers=$(docker network inspect --format '{{range .Containers}}{{println .Name}}{{end}}' "$mail_network")
  while IFS= read -r mail_peer; do
    [[ -z $mail_peer || $mail_peer == "$mail_app" || $mail_peer == "$mail_gateway" ]] || fail "邮件网络还连接了其他容器：$mail_peer"
  done <<< "$mail_peers"
  mail_network_exists=true
fi
for mail_volume in "${mail_volumes[@]}"; do
  if docker volume inspect "$mail_volume" >/dev/null 2>&1; then
    [[ $(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$mail_volume") == "$mail_instance" ]] || fail "数据卷 $mail_volume 属于其他安装。"
  fi
done

mail_temp=$(mktemp -d "${TMPDIR:-/tmp}/cloud-mail-gateway.XXXXXX")
trap 'rm -rf -- "$mail_temp"' EXIT
printf '%s\n' '正在拉取 GitHub 发布的邮件服务镜像…'
if ! docker pull ghcr.io/lsh-okok/cloud-mail:mta-main > "$mail_temp/pull.log" 2>&1; then
  cat "$mail_temp/pull.log" >&2; fail '邮件镜像拉取失败，现有应用未修改。'
fi
mail_digest=$(sed -n 's/^Digest: //p' "$mail_temp/pull.log")
[[ $mail_digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail '邮件镜像摘要无效。'
mail_image="ghcr.io/lsh-okok/cloud-mail@$mail_digest"
mail_repo_digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$mail_image")
awk -v expected="$mail_image" '$0==expected {found=1} END {exit !found}' <<< "$mail_repo_digests" || fail '邮件镜像仓库摘要不匹配。'
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$mail_image") == https://github.com/lsh-okok/cloud-mail ]] || fail '邮件镜像来源不匹配。'
[[ $(docker image inspect --format '{{index .Config.Labels "io.cloud-mail.component"}}' "$mail_image") == mta ]] || fail '拉取的镜像不是邮件服务。'
mail_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$mail_image")
[[ $mail_revision =~ ^[0-9a-f]{40}$ ]] || fail '邮件镜像没有有效的提交记录。'

if [[ $mail_network_exists == false ]]; then
  docker network create --label "cloud-mail.installation-id=$mail_instance" --subnet "$mail_subnet" "$mail_network" >/dev/null
fi
for mail_volume in "${mail_volumes[@]}"; do
  docker volume create --label "cloud-mail.installation-id=$mail_instance" "$mail_volume" >/dev/null
done
mail_app_aliases=$(docker container inspect --format "{{with index .NetworkSettings.Networks \"$mail_network\"}}{{range .Aliases}}{{println .}}{{end}}{{end}}" "$mail_app")
if ! awk '$0=="app" {found=1} END {exit !found}' <<< "$mail_app_aliases"; then
  if [[ -n $mail_app_aliases ]]; then docker network disconnect "$mail_network" "$mail_app"; fi
  docker network connect --alias app "$mail_network" "$mail_app"
fi
if [[ $mail_existing == true ]]; then
  docker stop -t 60 "$mail_gateway" >/dev/null
  docker rm "$mail_gateway" >/dev/null
fi
docker run -d --name "$mail_gateway" --hostname "$mail_host" --restart unless-stopped \
  --label "cloud-mail.installation-id=$mail_instance" --label cloud-mail.role=mta \
  --network "$mail_network" --network-alias mail -p 0.0.0.0:25:25 \
  -e "MAIL_HOST=$mail_host" -e "MAIL_DOMAINS=$mail_domains" -e "MAIL_NETWORK_SUBNET=$mail_subnet" \
  -e DKIM_SELECTOR=mail -e "SMTP_TLS_CERT_FILE=/certs/$mail_cert_relative" \
  -e "SMTP_TLS_KEY_FILE=/certs/${mail_cert_relative%/*}/privkey.pem" \
  --mount "type=bind,source=$mail_cert_root,target=/certs,readonly" \
  -v "${mail_volumes[0]}:/var/spool/postfix" -v "${mail_volumes[1]}:/etc/opendkim/keys" \
  -v "${mail_volumes[2]}:/var/log/postfix" \
  --health-cmd /usr/local/bin/mail-healthcheck --health-interval 30s --health-timeout 10s \
  --health-start-period 30s --health-retries 3 "$mail_image" >/dev/null
mail_deadline=$(( $(date +%s) + 180 ))
while (( $(date +%s) < mail_deadline )); do
  if docker exec "$mail_gateway" /usr/local/bin/mail-healthcheck >/dev/null 2>&1 && \
     docker exec "$mail_gateway" sh -c 'nc -z -w 2 app 2525 && nc -z -w 2 app 10040 && nc -z -w 2 app 10041' >/dev/null 2>&1; then
    printf '\n公网收信服务已启动\n邮件服务器：%s:25\n邮件容器：%s\nGitHub 提交：%s\n' "$mail_host" "$mail_gateway" "$mail_revision"
    printf '%s\n' '现有管理容器和数据已保留。请从外部邮箱发送测试邮件，确认进入收件箱。'
    show_dkim
    exit 0
  fi
  sleep 5
done
fail "邮件服务尚未就绪，请执行 docker logs --tail 80 $mail_gateway 查看原因；现有数据已保留。"
