#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOYKIT_REPO=""
DEPLOYKIT_LABEL=""
DEPLOYKIT_PACKAGE=""
DEPLOYKIT_SHA256=""
DEPLOYKIT_DEFAULT_BRANCH=""
DEPLOYKIT_FIREWALL=0
DEPLOYKIT_RUNNER_VERSION="2.337.0"
DEPLOYKIT_NODE_VERSION="22.18.0"
DEPLOYKIT_PM2_VERSION="6.0.8"
DEPLOYKIT_MIN_COMPOSE_VERSION="2.24.4"

usage() {
  echo "Usage: bootstrap.sh --repo owner/name --label server --package file.tgz --sha256 digest --default-branch branch [--configure-firewall]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) DEPLOYKIT_REPO="${2:?}"; shift 2 ;;
    --label) DEPLOYKIT_LABEL="${2:?}"; shift 2 ;;
    --package) DEPLOYKIT_PACKAGE="${2:?}"; shift 2 ;;
    --sha256) DEPLOYKIT_SHA256="${2:?}"; shift 2 ;;
    --default-branch) DEPLOYKIT_DEFAULT_BRANCH="${2:?}"; shift 2 ;;
    --configure-firewall) DEPLOYKIT_FIREWALL=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$DEPLOYKIT_REPO" && -n "$DEPLOYKIT_LABEL" && -n "$DEPLOYKIT_PACKAGE" && -n "$DEPLOYKIT_SHA256" && -n "$DEPLOYKIT_DEFAULT_BRANCH" ]] || usage
[[ "${EUID}" -eq 0 ]] || { echo "bootstrap must run as root" >&2; exit 1; }
[[ "$DEPLOYKIT_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid repository" >&2; exit 2; }
[[ "$DEPLOYKIT_LABEL" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "invalid server label" >&2; exit 2; }
[[ "$DEPLOYKIT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid checksum" >&2; exit 2; }
[[ "$DEPLOYKIT_DEFAULT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$DEPLOYKIT_DEFAULT_BRANCH" != *".."* ]] || { echo "invalid default branch" >&2; exit 2; }

IFS= read -r DEPLOYKIT_RUNNER_TOKEN || [[ -n "$DEPLOYKIT_RUNNER_TOKEN" ]]
[[ -n "$DEPLOYKIT_RUNNER_TOKEN" ]] || { echo "runner registration token is required on stdin" >&2; exit 2; }

log() { echo "[deploykit bootstrap] $*"; }
export DEBIAN_FRONTEND=noninteractive

if [[ ! -r /etc/os-release ]]; then
  echo "unsupported system: /etc/os-release missing" >&2
  exit 8
fi
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || { echo "v0.1 supports Ubuntu only (found ${ID:-unknown})" >&2; exit 8; }
case "${VERSION_ID:-}" in
  22.04|24.04) ;;
  *) echo "v0.1 supports Ubuntu 22.04 and 24.04 (found ${VERSION_ID:-unknown})" >&2; exit 8 ;;
esac

case "$(dpkg --print-architecture)" in
  amd64)
    DEPLOYKIT_NODE_ARCH="x64"
    DEPLOYKIT_NODE_SHA256="c1bfeecf1d7404fa74728f9db72e697decbd8119ccc6f5a294d795756dfcfca7"
    DEPLOYKIT_RUNNER_ARCH="x64"
    DEPLOYKIT_RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
    ;;
  arm64)
    DEPLOYKIT_NODE_ARCH="arm64"
    DEPLOYKIT_NODE_SHA256="04fca1b9afecf375f26b41d65d52aa1703a621abea5a8948c7d1e351e85edade"
    DEPLOYKIT_RUNNER_ARCH="arm64"
    DEPLOYKIT_RUNNER_SHA256="9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393"
    ;;
  *) echo "unsupported architecture" >&2; exit 8 ;;
esac

log "installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq openssl dnsutils nginx certbot ufw xz-utils util-linux

DEPLOYKIT_COMPOSE_VERSION="$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)"
if ! command -v docker >/dev/null 2>&1 || \
   [[ -z "$DEPLOYKIT_COMPOSE_VERSION" ]] || \
   ! dpkg --compare-versions "$DEPLOYKIT_COMPOSE_VERSION" ge "$DEPLOYKIT_MIN_COMPOSE_VERSION"; then
  log "installing Docker Engine and Compose"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
DEPLOYKIT_COMPOSE_VERSION="$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)"
[[ -n "$DEPLOYKIT_COMPOSE_VERSION" ]] && \
  dpkg --compare-versions "$DEPLOYKIT_COMPOSE_VERSION" ge "$DEPLOYKIT_MIN_COMPOSE_VERSION" || {
    echo "Docker Compose ${DEPLOYKIT_MIN_COMPOSE_VERSION} or newer is required" >&2
    exit 9
  }
systemctl enable --now docker nginx

DEPLOYKIT_NODE_ROOT="/opt/deploykit/toolchains/node/${DEPLOYKIT_NODE_VERSION}"
if [[ ! -x "$DEPLOYKIT_NODE_ROOT/bin/node" ]] || [[ "$("$DEPLOYKIT_NODE_ROOT/bin/node" --version)" != "v${DEPLOYKIT_NODE_VERSION}" ]]; then
  log "installing verified Node.js ${DEPLOYKIT_NODE_VERSION}"
  DEPLOYKIT_NODE_TARBALL="node-v${DEPLOYKIT_NODE_VERSION}-linux-${DEPLOYKIT_NODE_ARCH}.tar.xz"
  DEPLOYKIT_NODE_URL="https://nodejs.org/dist/v${DEPLOYKIT_NODE_VERSION}"
  DEPLOYKIT_NODE_TMP="$(mktemp -d)"
  curl -fsSLo "$DEPLOYKIT_NODE_TMP/$DEPLOYKIT_NODE_TARBALL" "$DEPLOYKIT_NODE_URL/$DEPLOYKIT_NODE_TARBALL"
  printf '%s  %s\n' "$DEPLOYKIT_NODE_SHA256" "$DEPLOYKIT_NODE_TMP/$DEPLOYKIT_NODE_TARBALL" | sha256sum -c -
  rm -rf "$DEPLOYKIT_NODE_ROOT"
  mkdir -p "$DEPLOYKIT_NODE_ROOT"
  tar -xJf "$DEPLOYKIT_NODE_TMP/$DEPLOYKIT_NODE_TARBALL" --strip-components=1 -C "$DEPLOYKIT_NODE_ROOT"
  rm -rf "$DEPLOYKIT_NODE_TMP"
fi
[[ "$("$DEPLOYKIT_NODE_ROOT/bin/node" --version)" == "v${DEPLOYKIT_NODE_VERSION}" ]] || { echo "Node.js version verification failed" >&2; exit 9; }
ln -sfn "$DEPLOYKIT_NODE_ROOT/bin/node" /usr/local/bin/node
ln -sfn "$DEPLOYKIT_NODE_ROOT/bin/npm" /usr/local/bin/npm
ln -sfn "$DEPLOYKIT_NODE_ROOT/bin/npx" /usr/local/bin/npx

log "verifying and installing DeployKit"
printf '%s  %s\n' "$DEPLOYKIT_SHA256" "$DEPLOYKIT_PACKAGE" | sha256sum -c -
DEPLOYKIT_CLI_STAGE="$(mktemp -d /opt/deploykit/.cli.XXXXXX)"
tar -xzf "$DEPLOYKIT_PACKAGE" --directory "$DEPLOYKIT_CLI_STAGE" --no-same-owner --no-same-permissions
[[ -f "$DEPLOYKIT_CLI_STAGE/package/package.json" && -f "$DEPLOYKIT_CLI_STAGE/package/dist/server-cli.cjs" ]] || {
  echo "DeployKit package does not contain the standalone server runtime" >&2
  exit 9
}
DEPLOYKIT_CLI_NAME="$(jq -r '.name' "$DEPLOYKIT_CLI_STAGE/package/package.json")"
DEPLOYKIT_CLI_VERSION="$(jq -r '.version' "$DEPLOYKIT_CLI_STAGE/package/package.json")"
[[ "$DEPLOYKIT_CLI_NAME" == "@project/deploykit" ]] || { echo "unexpected DeployKit package name" >&2; exit 9; }
[[ "$DEPLOYKIT_CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || { echo "invalid DeployKit package version" >&2; exit 9; }
DEPLOYKIT_CLI_ROOT="/opt/deploykit/cli/${DEPLOYKIT_CLI_VERSION}"
install -d -m 0755 /opt/deploykit/cli
if [[ -e "$DEPLOYKIT_CLI_ROOT" ]]; then
  [[ -f "$DEPLOYKIT_CLI_ROOT/.package-sha256" && "$(<"$DEPLOYKIT_CLI_ROOT/.package-sha256")" == "$DEPLOYKIT_SHA256" ]] || {
    echo "DeployKit ${DEPLOYKIT_CLI_VERSION} already exists with a different package checksum" >&2
    exit 9
  }
  rm -rf "$DEPLOYKIT_CLI_STAGE"
else
  printf '%s\n' "$DEPLOYKIT_SHA256" > "$DEPLOYKIT_CLI_STAGE/package/.package-sha256"
  chmod 0755 "$DEPLOYKIT_CLI_STAGE/package/dist/server-cli.cjs"
  mv "$DEPLOYKIT_CLI_STAGE/package" "$DEPLOYKIT_CLI_ROOT"
  rmdir "$DEPLOYKIT_CLI_STAGE"
fi
ln -sfn "$DEPLOYKIT_CLI_ROOT/dist/server-cli.cjs" /usr/local/bin/deploykit
[[ "$(deploykit --version)" == "$DEPLOYKIT_CLI_VERSION" ]] || { echo "DeployKit runtime version verification failed" >&2; exit 9; }
DEPLOYKIT_PM2_ROOT="/opt/deploykit/pm2/${DEPLOYKIT_PM2_VERSION}"
DEPLOYKIT_PM2_BIN="$DEPLOYKIT_PM2_ROOT/node_modules/.bin/pm2"
DEPLOYKIT_INSTALLED_PM2_VERSION="$(jq -r '.version // empty' "$DEPLOYKIT_PM2_ROOT/node_modules/pm2/package.json" 2>/dev/null || true)"
if [[ ! -x "$DEPLOYKIT_PM2_BIN" ]] || [[ "$DEPLOYKIT_INSTALLED_PM2_VERSION" != "$DEPLOYKIT_PM2_VERSION" ]]; then
  log "installing isolated PM2 ${DEPLOYKIT_PM2_VERSION}"
  install -d -m 0755 "$DEPLOYKIT_PM2_ROOT"
  "$DEPLOYKIT_NODE_ROOT/bin/npm" install \
    --prefix "$DEPLOYKIT_PM2_ROOT" \
    --no-save \
    --no-audit \
    --no-fund \
    "pm2@${DEPLOYKIT_PM2_VERSION}"
fi
DEPLOYKIT_INSTALLED_PM2_VERSION="$(jq -r '.version // empty' "$DEPLOYKIT_PM2_ROOT/node_modules/pm2/package.json" 2>/dev/null || true)"
[[ "$DEPLOYKIT_INSTALLED_PM2_VERSION" == "$DEPLOYKIT_PM2_VERSION" ]] || { echo "PM2 version verification failed" >&2; exit 9; }

install -d -m 0700 /etc/deploykit /etc/deploykit/targets
install -d -m 0755 /var/lib/deploykit /var/lib/deploykit/targets /srv/deploykit /var/log/deploykit /var/lib/deploykit/acme-webroot
touch /var/lib/deploykit/registry.lock
chmod 0600 /var/lib/deploykit/registry.lock

DEPLOYKIT_PUBLIC_IPV4="$(curl -4fsS --max-time 10 https://api.ipify.org || true)"
DEPLOYKIT_PUBLIC_IPV6="$(curl -6fsS --max-time 10 https://api64.ipify.org || true)"
if [[ -n "$DEPLOYKIT_PUBLIC_IPV4" ]] && ! "$DEPLOYKIT_NODE_ROOT/bin/node" -e 'const { isIP } = require("node:net"); process.exit(isIP(process.argv[1]) === 4 ? 0 : 1)' "$DEPLOYKIT_PUBLIC_IPV4"; then
  echo "public IPv4 discovery returned an invalid address" >&2
  exit 9
fi
if [[ -n "$DEPLOYKIT_PUBLIC_IPV6" ]] && ! "$DEPLOYKIT_NODE_ROOT/bin/node" -e 'const { isIP } = require("node:net"); process.exit(isIP(process.argv[1]) === 6 ? 0 : 1)' "$DEPLOYKIT_PUBLIC_IPV6"; then
  echo "public IPv6 discovery returned an invalid address" >&2
  exit 9
fi
[[ -n "$DEPLOYKIT_PUBLIC_IPV4" || -n "$DEPLOYKIT_PUBLIC_IPV6" ]] || {
  echo "could not discover a public server address required for direct DNS verification" >&2
  exit 9
}
DEPLOYKIT_SERVER_CONFIG="/etc/deploykit/server-${DEPLOYKIT_LABEL}.json"
DEPLOYKIT_SERVER_CONFIG_TMP="$(mktemp "/etc/deploykit/.server-${DEPLOYKIT_LABEL}.XXXXXX")"
jq -n \
  --arg label "$DEPLOYKIT_LABEL" \
  --arg repository "$DEPLOYKIT_REPO" \
  --arg ipv4 "$DEPLOYKIT_PUBLIC_IPV4" \
  --arg ipv6 "$DEPLOYKIT_PUBLIC_IPV6" \
  '{version:1,label:$label,repository:$repository,publicAddresses:([$ipv4,$ipv6]|map(select(length>0))),portRange:{start:20000,end:39999}}' \
  > "$DEPLOYKIT_SERVER_CONFIG_TMP"
chmod 0600 "$DEPLOYKIT_SERVER_CONFIG_TMP"
mv -f "$DEPLOYKIT_SERVER_CONFIG_TMP" "$DEPLOYKIT_SERVER_CONFIG"

DEPLOYKIT_REPO_SLUG="${DEPLOYKIT_REPO//\//-}"
DEPLOYKIT_RUNNER_ROOT="/opt/actions-runner/${DEPLOYKIT_REPO_SLUG}-${DEPLOYKIT_LABEL}"
mkdir -p "$DEPLOYKIT_RUNNER_ROOT"
DEPLOYKIT_HOOK_DIR="/etc/deploykit/runner-hooks"
DEPLOYKIT_HOOK_FILE="${DEPLOYKIT_HOOK_DIR}/${DEPLOYKIT_REPO_SLUG}-${DEPLOYKIT_LABEL}.sh"
install -d -m 0700 "$DEPLOYKIT_HOOK_DIR"
DEPLOYKIT_HOOK_TMP="$(mktemp "${DEPLOYKIT_HOOK_DIR}/.${DEPLOYKIT_REPO_SLUG}-${DEPLOYKIT_LABEL}.XXXXXX")"
cat > "$DEPLOYKIT_HOOK_TMP" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
expected_workflow='${DEPLOYKIT_REPO}/.github/workflows/deploykit.yml@refs/heads/${DEPLOYKIT_DEFAULT_BRANCH}'
if [[ "\${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" || "\${GITHUB_WORKFLOW_REF:-}" != "\$expected_workflow" || "\${GITHUB_REF_PROTECTED:-false}" != "true" ]]; then
  echo "DeployKit runner policy rejected workflow ref '\${GITHUB_WORKFLOW_REF:-unset}', event '\${GITHUB_EVENT_NAME:-unset}', or unprotected ref" >&2
  exit 78
fi
EOF
chmod 0700 "$DEPLOYKIT_HOOK_TMP"
mv -f "$DEPLOYKIT_HOOK_TMP" "$DEPLOYKIT_HOOK_FILE"
if [[ ! -f "$DEPLOYKIT_RUNNER_ROOT/.runner" ]]; then
  log "installing repo-scoped GitHub Actions runner"
  DEPLOYKIT_RUNNER_TMP="$(mktemp -d)"
  DEPLOYKIT_RUNNER_TARBALL="actions-runner-linux-${DEPLOYKIT_RUNNER_ARCH}-${DEPLOYKIT_RUNNER_VERSION}.tar.gz"
  curl -fsSLo "$DEPLOYKIT_RUNNER_TMP/$DEPLOYKIT_RUNNER_TARBALL" \
    "https://github.com/actions/runner/releases/download/v${DEPLOYKIT_RUNNER_VERSION}/${DEPLOYKIT_RUNNER_TARBALL}"
  printf '%s  %s\n' "$DEPLOYKIT_RUNNER_SHA256" "$DEPLOYKIT_RUNNER_TMP/$DEPLOYKIT_RUNNER_TARBALL" | sha256sum -c -
  tar -xzf "$DEPLOYKIT_RUNNER_TMP/$DEPLOYKIT_RUNNER_TARBALL" -C "$DEPLOYKIT_RUNNER_ROOT"
  rm -rf "$DEPLOYKIT_RUNNER_TMP"
  (
    cd "$DEPLOYKIT_RUNNER_ROOT"
    ./bin/installdependencies.sh
    RUNNER_ALLOW_RUNASROOT=1 ./config.sh --unattended \
      --url "https://github.com/${DEPLOYKIT_REPO}" \
      --token "$DEPLOYKIT_RUNNER_TOKEN" \
      --name "deploykit-${DEPLOYKIT_LABEL}" \
      --labels "deploykit,${DEPLOYKIT_LABEL}" \
      --work "_work" \
      --disableupdate \
      --replace
    RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install root
  )
else
  DEPLOYKIT_INSTALLED_RUNNER_VERSION="$("$DEPLOYKIT_RUNNER_ROOT/bin/Runner.Listener" --version)"
  [[ "$DEPLOYKIT_INSTALLED_RUNNER_VERSION" == "$DEPLOYKIT_RUNNER_VERSION" ]] || {
    echo "runner ${DEPLOYKIT_INSTALLED_RUNNER_VERSION} is installed; an explicit runner upgrade to ${DEPLOYKIT_RUNNER_VERSION} is required" >&2
    exit 9
  }
  jq -e --arg expected "https://github.com/${DEPLOYKIT_REPO}" '.gitHubUrl == $expected and .disableUpdate == true' "$DEPLOYKIT_RUNNER_ROOT/.runner" >/dev/null || {
    echo "existing runner registration is not pinned to ${DEPLOYKIT_REPO}; explicit re-enrollment is required" >&2
    exit 9
  }
  if [[ ! -f "$DEPLOYKIT_RUNNER_ROOT/.service" ]]; then
    (
      cd "$DEPLOYKIT_RUNNER_ROOT"
      RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install root
    )
  fi
  log "runner already enrolled and verified"
fi
DEPLOYKIT_RUNNER_ENV="$DEPLOYKIT_RUNNER_ROOT/.env"
DEPLOYKIT_RUNNER_ENV_TMP="$(mktemp "$DEPLOYKIT_RUNNER_ROOT/.env.XXXXXX")"
if [[ -f "$DEPLOYKIT_RUNNER_ENV" ]]; then
  awk '!/^ACTIONS_RUNNER_HOOK_JOB_STARTED=/' "$DEPLOYKIT_RUNNER_ENV" > "$DEPLOYKIT_RUNNER_ENV_TMP"
fi
printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$DEPLOYKIT_HOOK_FILE" >> "$DEPLOYKIT_RUNNER_ENV_TMP"
chmod 0600 "$DEPLOYKIT_RUNNER_ENV_TMP"
mv -f "$DEPLOYKIT_RUNNER_ENV_TMP" "$DEPLOYKIT_RUNNER_ENV"
(
  cd "$DEPLOYKIT_RUNNER_ROOT"
  RUNNER_ALLOW_RUNASROOT=1 ./svc.sh stop >/dev/null 2>&1 || true
  RUNNER_ALLOW_RUNASROOT=1 ./svc.sh start
)
unset DEPLOYKIT_RUNNER_TOKEN

install -d -m 0755 /etc/nginx/deploykit /etc/letsencrypt/renewal-hooks/deploy
DEPLOYKIT_NGINX_MAP="/etc/nginx/conf.d/deploykit-websocket-map.conf"
DEPLOYKIT_NGINX_MAP_TMP="$(mktemp /etc/nginx/conf.d/.deploykit-websocket-map.XXXXXX)"
DEPLOYKIT_NGINX_MAP_BACKUP=""
cat > "$DEPLOYKIT_NGINX_MAP_TMP" <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
EOF
chmod 0644 "$DEPLOYKIT_NGINX_MAP_TMP"
if [[ -e "$DEPLOYKIT_NGINX_MAP" ]]; then
  DEPLOYKIT_NGINX_MAP_BACKUP="$(mktemp /etc/nginx/conf.d/.deploykit-websocket-map.backup.XXXXXX)"
  cp -a "$DEPLOYKIT_NGINX_MAP" "$DEPLOYKIT_NGINX_MAP_BACKUP"
fi
mv -f "$DEPLOYKIT_NGINX_MAP_TMP" "$DEPLOYKIT_NGINX_MAP"
if ! nginx -t; then
  if [[ -n "$DEPLOYKIT_NGINX_MAP_BACKUP" ]]; then
    mv -f "$DEPLOYKIT_NGINX_MAP_BACKUP" "$DEPLOYKIT_NGINX_MAP"
  else
    rm -f "$DEPLOYKIT_NGINX_MAP"
  fi
  echo "DeployKit Nginx map was rejected; the previous configuration was restored" >&2
  exit 9
fi
if [[ -n "$DEPLOYKIT_NGINX_MAP_BACKUP" ]]; then
  rm -f "$DEPLOYKIT_NGINX_MAP_BACKUP"
fi

DEPLOYKIT_RENEWAL_HOOK_TMP="$(mktemp /etc/letsencrypt/renewal-hooks/deploy/.deploykit-nginx-reload.XXXXXX)"
cat > "$DEPLOYKIT_RENEWAL_HOOK_TMP" <<'EOF'
#!/usr/bin/env bash
set -e
nginx -t
systemctl reload nginx
EOF
chmod 0755 "$DEPLOYKIT_RENEWAL_HOOK_TMP"
mv -f "$DEPLOYKIT_RENEWAL_HOOK_TMP" /etc/letsencrypt/renewal-hooks/deploy/deploykit-nginx-reload
systemctl enable --now certbot.timer

if [[ "$DEPLOYKIT_FIREWALL" -eq 1 ]]; then
  log "configuring UFW"
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable
fi

systemctl reload nginx
log "server enrollment complete"
