// Every value entering the shell is quoted, including URLs containing apostrophes.
const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export function buildNodeInstallScript({ id, env, port, bundleUrl, bundleSha256, bundleImageId }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || typeof env !== 'string' || !env ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[a-f0-9]{64}$/i.test(bundleSha256) ||
      (bundleImageId !== undefined && (typeof bundleImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(bundleImageId)))) {
    throw new TypeError('Invalid node installation options.');
  }
  const url = new URL(bundleUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u001f\u007f]/.test(bundleUrl)) {
    throw new TypeError('Invalid node deployment bundle URL.');
  }
  return `#!/bin/sh
set -eu
umask 077
node_id=${shellQuote(id)}
node_port=${shellQuote(port)}
node_container="cloud-mail-node-$node_id"
node_volume="$node_container-data"
node_image="cloud-mail-node:$node_id"
node_install_root="\${CLOUD_MAIL_NODE_INSTALL_DIR:-\${HOME:?无法确定当前用户的主目录}/.cloud-mail/nodes/$node_id}"
node_bundle_url=${shellQuote(bundleUrl)}
node_bundle_sha256=${shellQuote(bundleSha256.toLowerCase())}
node_bundle_image_id=${shellQuote(bundleImageId || '')}

fail() { printf '%s\\n' "$*" >&2; exit 1; }
run_root() {
  if [ "$(id -u)" = 0 ]; then "$@";
  elif command -v sudo >/dev/null 2>&1; then sudo "$@";
  else fail '安装 Docker 需要 root 或 sudo 权限。'; fi
}
[ "$(uname -s)" = Linux ] || fail '此安装命令适用于 Linux 服务器。'
case "$node_install_root" in /*) ;; *) fail '节点安装目录必须为绝对路径。' ;; esac

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\\n' '正在安装 Docker…'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io ca-certificates curl coreutils tar
  elif command -v dnf >/dev/null 2>&1; then
    if [ -r /etc/os-release ]; then . /etc/os-release; fi
    case "\${ID:-}" in
      fedora) run_root dnf install -y moby-engine docker-cli ca-certificates curl coreutils tar ;;
      rhel|centos|rocky|almalinux)
        run_root dnf install -y dnf-plugins-core ca-certificates curl coreutils tar
        run_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        run_root dnf install -y docker-ce docker-ce-cli containerd.io ;;
      *) fail '暂不支持此发行版自动安装 Docker，请安装 Docker 后重新执行。' ;;
    esac
  else fail '请先为此 Linux 发行版安装 Docker，再重新执行本命令。'; fi
  if command -v systemctl >/dev/null 2>&1; then run_root systemctl enable --now docker; fi
fi

node_missing_tools=false
for node_tool in base64 cmp sha256sum tar; do
  command -v "$node_tool" >/dev/null 2>&1 || node_missing_tools=true
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then node_missing_tools=true; fi
if [ "$node_missing_tools" = true ]; then
  printf '%s\\n' '正在安装部署所需的下载与校验工具…'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl coreutils diffutils tar
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y ca-certificates curl coreutils diffutils tar
  else fail '缺少部署工具，请安装 curl、coreutils、diffutils 和 tar 后重试。'; fi
fi

node_docker_sudo=false
if ! docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then run_root systemctl start docker; fi
  if ! docker info >/dev/null 2>&1; then
    run_root docker info >/dev/null 2>&1 || fail '无法连接 Docker 服务，请检查服务状态与权限后重试。'
    node_docker_sudo=true
  fi
fi
docker_cmd() {
  if [ "$node_docker_sudo" = true ]; then run_root docker "$@"; else docker "$@"; fi
}

[ ! -L "$node_install_root" ] || fail '节点目录不能是符号链接。'
mkdir -p "$node_install_root"
chmod 700 "$node_install_root"
node_temp=$(mktemp -d "$node_install_root/.install-XXXXXX")
trap 'rm -rf "$node_temp"' EXIT HUP INT TERM
printf '%s' ${shellQuote(Buffer.from(env).toString('base64'))} | base64 -d > "$node_temp/node.env"
[ ! -L "$node_install_root/node.env" ] || fail '节点配置不能是符号链接。'
if [ ! -e "$node_install_root/node.env" ]; then
  ln "$node_temp/node.env" "$node_install_root/node.env" 2>/dev/null || true
fi
cmp -s "$node_temp/node.env" "$node_install_root/node.env" || fail '已有节点配置与本次命令不一致，已停止；原配置和数据未修改。'
chmod 600 "$node_install_root/node.env"

node_existing=false
if docker_cmd container inspect "$node_container" >/dev/null 2>&1; then
  node_existing_id=$(docker_cmd container inspect --format '{{index .Config.Labels "cloud-mail.node-id"}}' "$node_container")
  [ "$node_existing_id" = "$node_id" ] || fail '同名容器已被其他服务占用，已停止。'
  node_existing_port=$(docker_cmd container inspect --format '{{range (index .HostConfig.PortBindings "3000/tcp")}}{{println .HostPort}}{{end}}' "$node_container")
  [ "$node_existing_port" = "$node_port" ] || fail "已有节点使用端口 $node_existing_port，本次指定 $node_port。已停止，请使用原端口重新执行。"
  if [ -n "$node_bundle_image_id" ]; then
    node_existing_image=$(docker_cmd container inspect --format '{{.Image}}' "$node_container")
    [ "$node_existing_image" = "$node_bundle_image_id" ] || fail '已有节点的镜像版本与发布包不同，已停止。请使用原发布包；版本升级需另行处理。'
  fi
  node_existing=true
fi

if [ "$node_existing" = true ]; then
  printf '%s\\n' '正在启动已有节点，保留原配置与数据…'
  docker_cmd start "$node_container" >/dev/null
else
  node_tagged_image=$(docker_cmd image inspect --format '{{.Id}}' "$node_image" 2>/dev/null || true)
  if [ -n "$node_tagged_image" ]; then
    if [ -n "$node_bundle_image_id" ]; then
      [ "$node_tagged_image" = "$node_bundle_image_id" ] || fail '同名镜像与发布包版本不一致，已停止。'
    fi
  else
    printf '%s\\n' '正在下载并校验主节点提供的安装包…'
    if command -v curl >/dev/null 2>&1; then
      curl --fail --silent --show-error --location --connect-timeout 15 --max-time 600 --output "$node_temp/bundle.tar.gz" "$node_bundle_url"
    elif command -v wget >/dev/null 2>&1; then
      wget -q --timeout=60 -O "$node_temp/bundle.tar.gz" "$node_bundle_url"
    else fail '缺少 curl 或 wget，请安装其中一个后重试。'; fi
    command -v sha256sum >/dev/null 2>&1 || fail '缺少 sha256sum，请安装 coreutils 后重试。'
    printf '%s  %s\\n' "$node_bundle_sha256" "$node_temp/bundle.tar.gz" | sha256sum -c - >/dev/null || fail '安装包校验失败，已停止部署。'
    if [ -n "$node_bundle_image_id" ]; then
      printf '%s\\n' '正在导入主节点提供的镜像，无需联网构建…'
      docker_cmd load --input "$node_temp/bundle.tar.gz" >/dev/null
      docker_cmd image inspect "$node_bundle_image_id" >/dev/null 2>&1 || fail '安装包未包含预期镜像，已停止部署。'
      docker_cmd tag "$node_bundle_image_id" "$node_image"
    else
      mkdir "$node_temp/source"
      tar -xzf "$node_temp/bundle.tar.gz" -C "$node_temp/source"
      printf '%s\\n' '正在构建节点镜像，首次构建可能需要数分钟…'
      docker_cmd build --tag "$node_image" "$node_temp/source"
    fi
  fi
  printf '%s\\n' '正在启动节点…'
  docker_cmd volume create "$node_volume" >/dev/null
  docker_cmd run -d --name "$node_container" --label "cloud-mail.node-id=$node_id" \\
    --restart unless-stopped --security-opt no-new-privileges:true \\
    --env-file "$node_install_root/node.env" \\
    -e NODE_ROLE=replica -e PORT=3000 -e DATA_DIR=/data \\
    -e SQLITE_PATH=/data/cloud-mail.sqlite -e OBJECTS_DIR=/data/objects \\
    -e STATIC_DIR=/app/mail-worker/dist -e APP_BASE_PATH= \\
    -e "APP_URL=http://localhost:$node_port" \\
    -p "$node_port:3000" -v "$node_volume:/data" "$node_image" >/dev/null
fi

printf '%s\\n' '服务已启动，正在等待节点完成首次同步（最多 180 秒）…'
node_deadline=$(( $(date +%s) + 180 ))
while :; do
  node_remaining=$(( node_deadline - $(date +%s) ))
  [ "$node_remaining" -gt 0 ] || break
  node_probe_timeout=$(( node_remaining * 1000 ))
  if [ "$node_probe_timeout" -gt 4000 ]; then node_probe_timeout=4000; fi
  if docker_cmd exec "$node_container" node -e 'fetch("http://127.0.0.1:3000/health/ready", {signal: AbortSignal.timeout(Number(process.argv[1]))}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$node_probe_timeout" >/dev/null 2>&1; then
    printf '%s\\n' "部署成功，节点已同步并可取信。访问端口：$node_port。"
    printf '%s\\n' "配置已保存：$node_install_root/node.env"
    exit 0
  fi
  node_running=$(docker_cmd container inspect --format '{{.State.Running}}' "$node_container")
  [ "$node_running" = true ] || fail "节点容器已停止，请执行 docker logs $node_container 查看原因，再重新执行安装命令。"
  node_remaining=$(( node_deadline - $(date +%s) ))
  [ "$node_remaining" -gt 0 ] || break
  if [ "$node_remaining" -gt 5 ]; then sleep 5; else sleep "$node_remaining"; fi
done
fail "节点已启动但尚未就绪，服务和数据已保留。请在节点管理查看同步状态，或执行 docker logs $node_container 排查主节点连接。"
`;
}
