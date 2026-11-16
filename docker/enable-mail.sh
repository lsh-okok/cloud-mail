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
mail_image_ref=ghcr.io/lsh-okok/cloud-mail:main
mail_original_args=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir|--name|--npm-container|--cert-root|--cert-name|--image)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail "$1 缺少参数值。"
      case "$1" in
        --dir) mail_dir=$2 ;; --name) mail_name=$2 ;; --npm-container) mail_npm=$2 ;;
        --cert-root) mail_cert_root=$2 ;; --cert-name) mail_cert_name=$2 ;;
        --image) mail_image_ref=$2 ;;
      esac
      shift 2 ;;
    --show-dkim) mail_show_dkim=true; shift ;;
    --help|-h)
      printf '%s\n' '用法：sudo bash enable-mail.sh [--dir /opt/cloud-mail-primary] [--name 容器名] [--npm-container npm] [--cert-root NPM证书根目录] [--cert-name npm-1]' \
        '把已有管理主节点更新为应用与邮件同容器，开放公网25端口，保留账号、队列、DKIM及原网络配置。' \
        '默认选择 NPM 中覆盖 MAIL_HOST 的证书并拉取统一 main 镜像；--image 可指定官方 sha-完整提交号或 sha256 摘要。' \
        '只支持本机 Unix socket Docker。合并实例重复执行保留原版本，不再次升级。' \
        '仅查看可直接粘贴到 Cloudflare 的 DKIM 名称和内容：bash enable-mail.sh --show-dkim [--dir 安装目录]'
      exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done
[[ $mail_image_ref == ghcr.io/lsh-okok/cloud-mail:main || $mail_image_ref =~ ^ghcr\.io/lsh-okok/cloud-mail:sha-[0-9a-f]{40}$ || $mail_image_ref =~ ^ghcr\.io/lsh-okok/cloud-mail@sha256:[0-9a-f]{64}$ ]] || fail '只能使用官方 main、sha-完整提交号或 sha256 摘要镜像。'
[[ $(uname -s) == Linux ]] || fail '邮件启动脚本适用于 Linux 服务器。'
case "$(uname -m)" in x86_64|amd64) ;; *) fail '官方镜像仅支持 Linux amd64。' ;; esac
if [[ $(id -u) != 0 ]]; then exec sudo bash "$0" "${mail_original_args[@]}"; fi
mail_tools=(docker awk sed)
if [[ $mail_show_dkim == false ]]; then mail_tools+=(openssl ss sha256sum curl); fi
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
[[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.installation-id"}}' "$mail_app") == "$mail_instance" ]] || fail '应用容器不属于此安装。'
[[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.role"}}' "$mail_app") == primary ]] || fail '应用容器不是本实例主节点。'
[[ $(docker container inspect --format '{{.State.Running}}' "$mail_app") == true ]] || fail '请先启动管理主节点。'
app_setting() { docker exec "$mail_app" node -p 'process.env[process.argv[1]] || ""' "$1"; }
[[ $(app_setting NODE_ROLE) == primary ]] || fail '只能为管理主节点启用收信。'
mail_domains=$(app_setting MAIL_DOMAINS)
[[ $mail_domains =~ ^[a-zA-Z0-9][a-zA-Z0-9.,-]*$ ]] || fail '应用 MAIL_DOMAINS 无效。'
mail_gateway="$mail_app-mail"
mail_existing=false
mail_combined=$(app_setting MAIL_ENABLED)
if docker container inspect "$mail_gateway" >/dev/null 2>&1; then
  [[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.installation-id"}}' "$mail_gateway") == "$mail_instance" ]] || fail '同名邮件容器属于其他安装。'
  [[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.role"}}' "$mail_gateway") == mta ]] || fail '同名容器不是本实例的邮件服务。'
  mail_existing=true
fi
mail_key_container=$mail_gateway
if [[ $mail_combined == true ]]; then
  [[ $mail_existing == false ]] || fail '合并容器与旧邮件容器同时存在，请先检查；未修改现有服务。'
  mail_key_container=$mail_app
fi

show_dkim() {
  local mail_domain mail_raw mail_txt
  local -a mail_domain_list
  printf '%s\n' 'Cloudflare DNS：每个域名添加一条 TXT 记录，将“内容”下方整行直接粘贴到内容框。'
  IFS=, read -r -a mail_domain_list <<< "$mail_domains"
  for mail_domain in "${mail_domain_list[@]}"; do
    mail_raw=$(docker exec "$mail_key_container" cat "/etc/opendkim/keys/$mail_domain/mail.txt") || fail "无法读取 $mail_domain 的 DKIM 公钥，请确认邮件容器已启动且密钥已生成。"
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
  [[ $mail_existing == true || $mail_combined == true ]] || fail '尚未找到本实例的邮件容器，请先启用公网收信。'
  show_dkim
  exit 0
fi

[[ -f $mail_dir/primary.env && ! -L $mail_dir/primary.env ]] || fail '主节点 primary.env 缺失，已停止。'
mail_checksum=$(sha256sum "$mail_dir/primary.env"); mail_checksum=${mail_checksum%% *}
[[ $mail_checksum == "$(read_state ENV_SHA256)" ]] || fail '主节点配置与安装记录不一致，已停止。'
if [[ $mail_combined == true ]]; then
  [[ $(read_state FORMAT) == 3 && -f $mail_dir/mail.env && ! -L $mail_dir/mail.env ]] || fail '合并邮件配置记录不完整，已停止。'
  mail_checksum=$(sha256sum "$mail_dir/mail.env"); mail_checksum=${mail_checksum%% *}
  [[ $mail_checksum == "$(read_state MAIL_ENV_SHA256)" ]] || fail '邮件运行配置与安装记录不一致。'
  [[ $(docker container inspect --format '{{.Image}}' "$mail_app") == "$(read_state IMAGE_ID)" ]] || fail '合并容器镜像与安装记录不一致。'
  docker exec "$mail_app" /usr/local/bin/cloud-mail-healthcheck >/dev/null || fail '合并邮件服务尚未就绪，请检查容器日志。'
  printf '%s\n' '公网收信服务已启动；原合并容器、配置和镜像保持不变。'
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
  elif [[ $mail_existing == true ]]; then fail "原邮件数据卷 $mail_volume 缺失，已停止。"
  fi
done

mail_docker_host=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
[[ $mail_docker_host == unix:///* ]] || fail '迁移仅支持本机 Unix socket Docker，请在安装主机执行。'
mail_socket=${mail_docker_host#unix://}
mail_lock="$mail_dir/.mail-transition-lock"
mkdir "$mail_lock" 2>/dev/null || fail '已有邮件迁移正在执行；异常中断后请先检查容器与 .mail-transition 目录。'
mail_temp=$(mktemp -d "$mail_dir/.mail-transition.XXXXXX")
cp -p "$mail_state" "$mail_temp/original-state"
mail_transition=false
mail_success=false
mail_app_backup="$mail_app-before-unified"
mail_gateway_backup="$mail_gateway-before-unified"
mail_new_created=false
mail_app_renamed=false
mail_gateway_renamed=false
mail_old_gateway_running=false
mail_env_checksum=''
restore_metadata() {
  local current_checksum
  # Always restore metadata, including when service recovery itself fails.
  cp -p "$mail_temp/original-state" "$mail_temp/restored-state" || return 1
  mv "$mail_temp/restored-state" "$mail_state" || return 1
  if [[ -e $mail_dir/mail.env ]]; then
    [[ -n $mail_env_checksum && -f $mail_dir/mail.env && ! -L $mail_dir/mail.env ]] || return 1
    current_checksum=$(sha256sum "$mail_dir/mail.env"); current_checksum=${current_checksum%% *}
    [[ $current_checksum == "$mail_env_checksum" ]] || return 1
    rm -f -- "$mail_dir/mail.env" || return 1
  fi
}
connect_network() {
  curl --silent --show-error --fail --unix-socket "$mail_socket" -H 'Content-Type: application/json' \
    --data-binary "@$mail_temp/connect-$1.json" "http://localhost/networks/$1/connect" >/dev/null
}
rollback() {
  printf '%s\n' '迁移未完成，正在恢复原容器；所有数据卷均保留。' >&2
  if [[ $mail_new_created == true ]] && docker container inspect "$mail_app" >/dev/null 2>&1; then
    [[ $(docker container inspect --format '{{index .Config.Labels "cloud-mail.installation-id"}}' "$mail_app") == "$mail_instance" &&
       $(docker container inspect --format '{{index .Config.Labels "cloud-mail.mail-enabled"}}' "$mail_app") == true &&
       $(docker container inspect --format '{{.Image}}' "$mail_app") == "$mail_image_id" ]] || return 1
    docker stop -t 120 "$mail_app" >/dev/null 2>&1 || return 1
    docker rm "$mail_app" >/dev/null 2>&1 || return 1
  fi
  if [[ $mail_app_renamed == true ]] && docker container inspect "$mail_app_backup" >/dev/null 2>&1; then
    docker rename "$mail_app_backup" "$mail_app" >/dev/null 2>&1 || return 1
    local network current_networks
    current_networks=$(docker container inspect --format '{{range $name,$network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$mail_app") || return 1
    while IFS= read -r network; do
      [[ -n $network ]] || continue
      if ! awk -v expected="$network" '$0==expected {found=1} END {exit !found}' <<< "$current_networks"; then connect_network "$network" || return 1; fi
    done < "$mail_temp/networks"
  fi
  docker start "$mail_app" >/dev/null 2>&1 || return 1
  if [[ $mail_gateway_renamed == true ]] && docker container inspect "$mail_gateway_backup" >/dev/null 2>&1; then docker rename "$mail_gateway_backup" "$mail_gateway" >/dev/null 2>&1 || return 1; fi
  if [[ $mail_existing == true && $mail_old_gateway_running == true ]]; then docker start "$mail_gateway" >/dev/null 2>&1 || return 1; fi
}
cleanup() {
  local result=$?
  trap - EXIT INT HUP TERM
  if [[ $mail_transition == true && $mail_success == false ]]; then
    local recovery_failed=false
    rollback || recovery_failed=true
    restore_metadata || recovery_failed=true
    if [[ $recovery_failed == true ]]; then
      printf '自动恢复未全部完成。保留 %s、%s、%s 和全部数据卷；检查 docker ps -a，核对 original-state 与当前安装记录后恢复原容器。\n' "$mail_app_backup" "$mail_gateway_backup" "$mail_temp" >&2
      rmdir "$mail_lock" 2>/dev/null || true
      exit 1
    fi
  fi
  rm -rf -- "$mail_temp"
  rmdir "$mail_lock" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
curl --silent --show-error --fail --unix-socket "$mail_socket" http://localhost/_ping >/dev/null || fail '无法连接本机 Docker API，现有服务未修改。'
for mail_backup in "$mail_app_backup" "$mail_gateway_backup"; do
  if docker container inspect "$mail_backup" >/dev/null 2>&1; then fail "存在之前迁移的恢复容器 $mail_backup，请人工检查后再执行。"; fi
done
[[ ! -e $mail_dir/mail.env && ! -L $mail_dir/mail.env ]] || fail '存在未登记的 mail.env，拒绝覆盖。'
docker container inspect "$mail_app" > "$mail_temp/app.json"
mail_app_volumes=$(docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$mail_app")
while IFS= read -r mail_original_volume; do
  [[ -n $mail_original_volume ]] || continue
  [[ $(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$mail_original_volume") == "$mail_instance" ]] || fail "原应用卷 $mail_original_volume 缺少本安装身份，已停止。"
done <<< "$mail_app_volumes"
if [[ $mail_existing == true ]]; then
  docker container inspect "$mail_gateway" > "$mail_temp/gateway.json"
  mail_old_gateway_running=$(docker container inspect --format '{{.State.Running}}' "$mail_gateway")
else printf '[]' > "$mail_temp/gateway.json"; fi
docker container inspect --format '{{range $name,$network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$mail_app" > "$mail_temp/networks"
while IFS= read -r mail_network; do
  [[ $mail_network =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail '原容器网络名称无效。'
done < "$mail_temp/networks"
[[ -s $mail_temp/networks ]] || fail '原容器没有可保留的网络配置。'
printf '%s\n' '正在拉取包含应用与邮件服务的官方统一镜像…'
if ! docker pull "$mail_image_ref" > "$mail_temp/pull.log" 2>&1; then fail '统一镜像拉取失败，现有服务未修改。'; fi
mail_digest=$(sed -n 's/^Digest: //p' "$mail_temp/pull.log")
[[ $mail_digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail '统一镜像摘要无效。'
mail_image="ghcr.io/lsh-okok/cloud-mail@$mail_digest"
[[ $mail_image_ref != *@* || $mail_image_ref == "$mail_image" ]] || fail '镜像摘要与指定版本不一致。'
mail_repo_digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$mail_image")
awk -v expected="$mail_image" '$0==expected {found=1} END {exit !found}' <<< "$mail_repo_digests" || fail '统一镜像仓库摘要不匹配。'
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$mail_image") == https://github.com/lsh-okok/cloud-mail ]] || fail '统一镜像来源不匹配。'
[[ $(docker image inspect --format '{{index .Config.Labels "io.cloud-mail.mail-capable"}}' "$mail_image") == true ]] || fail '拉取的镜像不支持同容器邮件服务。'
mail_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$mail_image")
[[ $mail_revision =~ ^[0-9a-f]{40}$ ]] || fail '统一镜像没有有效提交记录。'
[[ $mail_image_ref != *:sha-* || $mail_revision == "${mail_image_ref##*:sha-}" ]] || fail '镜像提交与指定版本不一致。'
mail_image_id=$(docker image inspect --format '{{.Id}}' "$mail_image")
[[ $mail_image_id =~ ^sha256:[0-9a-f]{64}$ ]] || fail '统一镜像 ID 无效。'
docker image inspect "$mail_image" > "$mail_temp/image.json"
printf '%s' "$mail_host" > "$mail_temp/host"
printf '%s' "$mail_cert_root" > "$mail_temp/cert-root"
printf '%s' "$mail_cert_relative" > "$mail_temp/cert-relative"
printf '%s' "$mail_image" > "$mail_temp/image-ref"
printf '%s' "$mail_app" > "$mail_temp/name"
printf '%s' "$mail_instance" > "$mail_temp/instance"
cat > "$mail_temp/merge.mjs" <<'NODE'
import fs from 'node:fs';
const dir = process.argv[2], read = file => fs.readFileSync(`${dir}/${file}`, 'utf8');
const old = JSON.parse(read('app.json'))[0], image = JSON.parse(read('image.json'))[0];
const gateway = JSON.parse(read('gateway.json'))[0], name = read('name'), instance = read('instance');
if (JSON.stringify(old.Config.Cmd) !== JSON.stringify(['node','mail-worker/server-dist/index.cjs']) || old.Config.Entrypoint?.at(-1) !== '/usr/local/bin/cloud-mail-entrypoint') throw Error('Unsupported custom application command.');
if (['host','none'].includes(old.HostConfig.NetworkMode) || old.HostConfig.NetworkMode?.startsWith('container:')) throw Error('Unsupported network mode.');
if (old.Config.Labels?.['cloud-mail.installation-id'] !== instance) throw Error('Invalid application ownership.');
const targets = ['/var/spool/postfix','/etc/opendkim/keys','/var/log/postfix'];
const volumes = [name+'-mail-spool',name+'-dkim',name+'-mail-logs'];
if (gateway) for (let i=0; i<targets.length; i++) {
  if (!gateway.Mounts.some(m => m.Type==='volume' && m.Destination===targets[i] && m.Name===volumes[i])) throw Error('Original mail volume mapping differs.');
}
const env = new Map();
for (const item of [...(image.Config.Env || []),...(old.Config.Env || [])]) {
  if (typeof item!=='string' || /[\r\n\0]/.test(item) || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) throw Error('Unsupported environment value.');
  const at=item.indexOf('='); env.set(item.slice(0,at),item.slice(at+1));
}
for (const [k,v] of Object.entries({MAIL_ENABLED:'true',NODE_ROLE:'primary',MAIL_INTERNAL_HOST:'127.0.0.1',SMTP_HOST:'127.0.0.1',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REQUIRE_TLS:'false',MAIL_NETWORK_SUBNET:'127.0.0.0/8',LMTP_PORT:'2525',POLICY_PORT:'10040',DOMAIN_MAP_PORT:'10041',DKIM_SELECTOR:'mail',SMTP_TLS_CERT_FILE:'/certs/'+read('cert-relative'),SMTP_TLS_KEY_FILE:'/certs/'+read('cert-relative').replace(/[^/]+$/,'privkey.pem')})) env.set(k,v);
env.delete('SMTP_USER'); env.delete('SMTP_PASSWORD');
const config={...old.Config,Image:read('image-ref'),Env:[...env].map(([k,v])=>`${k}=${v}`),Entrypoint:image.Config.Entrypoint,Cmd:image.Config.Cmd,Healthcheck:image.Config.Healthcheck,Hostname:read('host'),StopTimeout:120};
config.Labels={...old.Config.Labels,'cloud-mail.role':'primary','cloud-mail.mail-enabled':'true'};
for (const key of ['org.opencontainers.image.revision','org.opencontainers.image.source','io.cloud-mail.component','io.cloud-mail.mail-capable']) {
  if (image.Config.Labels?.[key] !== undefined) config.Labels[key]=image.Config.Labels[key];
  else delete config.Labels[key];
}
const host=structuredClone(old.HostConfig);
if (Object.keys(host.PortBindings || {}).some(port=>['2525/tcp','10040/tcp','10041/tcp','587/tcp'].includes(port))) throw Error('Internal mail ports must not be published.');
host.PortBindings={...host.PortBindings,'25/tcp':[{HostIp:'0.0.0.0',HostPort:'25'}]};
config.ExposedPorts={...config.ExposedPorts,'25/tcp':{}};
const replaced=new Set([...targets,'/certs']);
host.Binds=(host.Binds || []).filter(value=>!replaced.has(value.split(':')[1]));
host.Mounts=(host.Mounts || []).filter(value=>!replaced.has(value.Target));
for (let i=0; i<targets.length; i++) host.Mounts.push({Type:'volume',Source:volumes[i],Target:targets[i]});
host.Mounts.push({Type:'bind',Source:read('cert-root'),Target:'/certs',ReadOnly:true});
const endpoints={};
for (const [network,e] of Object.entries(old.NetworkSettings.Networks)) endpoints[network]={IPAMConfig:e.IPAMConfig,Links:e.Links,Aliases:e.Aliases,DriverOpts:e.DriverOpts};
const primary=Object.entries(old.NetworkSettings.Networks).find(([network,e])=>network===host.NetworkMode || e.NetworkID===host.NetworkMode || host.NetworkMode==='default' && network==='bridge')?.[0];
if (!primary) throw Error('Original primary network cannot be identified.');
process.umask(0o077);
for (const [network,endpoint] of Object.entries(endpoints)) fs.writeFileSync(`${dir}/connect-${network}.json`,JSON.stringify({Container:name,EndpointConfig:endpoint}));
fs.writeFileSync(`${dir}/additional-networks`,Object.keys(endpoints).filter(network=>network!==primary).join('\n')+'\n');
fs.writeFileSync(`${dir}/create.json`,JSON.stringify({...config,HostConfig:host,NetworkingConfig:{EndpointsConfig:{[primary]:endpoints[primary]}}}));
fs.writeFileSync(`${dir}/runtime.env`,config.Env.join('\n')+'\n');
NODE
# Configuration transformation has no network, Docker socket or host-runtime dependency.
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --entrypoint node --mount "type=bind,source=$mail_temp,target=/config" "$mail_image" /config/merge.mjs /config >/dev/null || fail '原容器配置无法安全合并，现有服务未修改。'
[[ -s $mail_temp/create.json && -s $mail_temp/runtime.env ]] || fail '未能生成合并配置，现有服务未修改。'
for mail_volume in "${mail_volumes[@]}"; do docker volume create --label "cloud-mail.installation-id=$mail_instance" "$mail_volume" >/dev/null; done
mail_transition=true
if [[ $mail_existing == true ]]; then
  docker stop -t 120 "$mail_gateway" >/dev/null
  mail_gateway_renamed=true
  docker rename "$mail_gateway" "$mail_gateway_backup"
fi
docker stop -t 120 "$mail_app" >/dev/null
mail_app_renamed=true
docker rename "$mail_app" "$mail_app_backup"
while IFS= read -r mail_network; do
  docker network disconnect "$mail_network" "$mail_app_backup"
done < "$mail_temp/networks"
mail_new_created=true
if ! curl --silent --show-error --fail --unix-socket "$mail_socket" -H 'Content-Type: application/json' --data-binary "@$mail_temp/create.json" --output "$mail_temp/create-response.json" "http://localhost/containers/create?name=$mail_app"; then fail '合并容器创建失败，正在恢复原服务。'; fi
while IFS= read -r mail_network; do
  [[ -z $mail_network ]] || connect_network "$mail_network" || fail '原网络连接失败，正在恢复原服务。'
done < "$mail_temp/additional-networks"
docker start "$mail_app" >/dev/null
mail_deadline=$(( $(date +%s) + 180 ))
mail_ready=false
while (( $(date +%s) < mail_deadline )); do
  if docker exec "$mail_app" /usr/local/bin/cloud-mail-healthcheck >/dev/null 2>&1; then mail_ready=true; break; fi
  [[ $(docker container inspect --format '{{.State.Running}}' "$mail_app") == true ]] || break
  sleep 5
done
[[ $mail_ready == true ]] || fail '合并邮件服务尚未就绪，正在恢复原容器；数据卷未删除。'
mail_env_checksum=$(sha256sum "$mail_temp/runtime.env"); mail_env_checksum=${mail_env_checksum%% *}
awk '!/^(FORMAT|SOURCE_MODE|SOURCE_VALUE|IMAGE_ID|IMAGE_DIGEST|IMAGE_REVISION|MAIL_ENV_SHA256)=/' "$mail_state" > "$mail_temp/state"
cat >> "$mail_temp/state" <<STATE
FORMAT=3
SOURCE_MODE=registry
SOURCE_VALUE=$mail_image_ref
IMAGE_ID=$mail_image_id
IMAGE_DIGEST=$mail_image
IMAGE_REVISION=$mail_revision
MAIL_ENV_SHA256=$mail_env_checksum
STATE
chmod 600 "$mail_temp/state" "$mail_temp/runtime.env"
mv "$mail_temp/runtime.env" "$mail_dir/mail.env"
if ! mv "$mail_temp/state" "$mail_state"; then fail '无法提交安装记录，正在恢复原服务。'; fi
mail_success=true
docker rm "$mail_app_backup" >/dev/null || printf '旧停止容器 %s 可在核对后手动 docker rm；不要删除数据卷。\n' "$mail_app_backup" >&2
if [[ $mail_gateway_renamed == true ]]; then docker rm "$mail_gateway_backup" >/dev/null || printf '旧停止容器 %s 可在核对后手动 docker rm；不要删除数据卷。\n' "$mail_gateway_backup" >&2; fi
mail_key_container=$mail_app
printf '\n公网收信服务已启动\n邮件服务器：%s:25\n统一容器：%s\nGitHub 提交：%s\n' "$mail_host" "$mail_app" "$mail_revision"
printf '%s\n' '应用、账号、队列、DKIM、原网络和数据卷已保留；邮件内部端口只在容器内通信。'
show_dkim
