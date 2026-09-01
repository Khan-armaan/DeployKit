#!/usr/bin/env bash
# Installs the DeployKit restricted gateway on an Ubuntu VPS.
#
# The v0.1 installer enrolled a repository-scoped GitHub Actions runner as root,
# which handed trusted repository code the whole host. This installer enrolls no
# runner at all. It installs the verified standalone runtime, a dedicated
# non-login gateway account, a root-owned binding that fixes this host's
# repository/Environment/target identity, one narrowly scoped sudo entry, and a
# stable read-only VPS-to-GitHub repository key. Deployments arrive from a
# GitHub-hosted runner through the forced command and nowhere else.
#
# Every provisioning check the previous installer performed is retained: Ubuntu
# release, architecture, base packages, Docker Engine and a minimum Compose
# version, a checksum-verified pinned Node.js, an isolated pinned PM2, the
# state directories, public-address discovery, the Nginx map with rollback on
# `nginx -t` failure, and the validated Certbot renewal hook.
set -Eeuo pipefail

DEPLOYKIT_REPOSITORY=""
DEPLOYKIT_GITHUB_ENVIRONMENT=""
DEPLOYKIT_TARGET_NAME=""
DEPLOYKIT_TARGET_ID=""
DEPLOYKIT_BINDING_ID=""
DEPLOYKIT_PACKAGE=""
DEPLOYKIT_PACKAGE_NAME=""
DEPLOYKIT_SHA256=""
DEPLOYKIT_SSH_PORT="22"
DEPLOYKIT_FIREWALL=0
DEPLOYKIT_NODE_VERSION="22.18.0"
DEPLOYKIT_PM2_VERSION="6.0.8"
DEPLOYKIT_MIN_COMPOSE_VERSION="2.24.4"
DEPLOYKIT_GATEWAY_USER="deploykit-gateway"
DEPLOYKIT_GATEWAY_HOME="/var/lib/deploykit-gateway"
DEPLOYKIT_GATEWAY_ENTRY="/usr/local/lib/deploykit/gateway-entry"

usage() {
  cat >&2 <<'USAGE'
Usage: bootstrap.sh --repository owner/name --github-environment NAME --target-name NAME
                    --target-id ID --binding-id ID --package FILE.tgz --package-name NAME
                    --sha256 DIGEST [--ssh-port PORT] [--configure-firewall]
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository) DEPLOYKIT_REPOSITORY="${2:?}"; shift 2 ;;
    --github-environment) DEPLOYKIT_GITHUB_ENVIRONMENT="${2:?}"; shift 2 ;;
    --target-name) DEPLOYKIT_TARGET_NAME="${2:?}"; shift 2 ;;
    --target-id) DEPLOYKIT_TARGET_ID="${2:?}"; shift 2 ;;
    --binding-id) DEPLOYKIT_BINDING_ID="${2:?}"; shift 2 ;;
    --package) DEPLOYKIT_PACKAGE="${2:?}"; shift 2 ;;
    --package-name) DEPLOYKIT_PACKAGE_NAME="${2:?}"; shift 2 ;;
    --sha256) DEPLOYKIT_SHA256="${2:?}"; shift 2 ;;
    --ssh-port) DEPLOYKIT_SSH_PORT="${2:?}"; shift 2 ;;
    --configure-firewall) DEPLOYKIT_FIREWALL=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$DEPLOYKIT_REPOSITORY" && -n "$DEPLOYKIT_GITHUB_ENVIRONMENT" && -n "$DEPLOYKIT_TARGET_NAME" ]] || usage
[[ -n "$DEPLOYKIT_TARGET_ID" && -n "$DEPLOYKIT_BINDING_ID" && -n "$DEPLOYKIT_PACKAGE" ]] || usage
[[ -n "$DEPLOYKIT_PACKAGE_NAME" && -n "$DEPLOYKIT_SHA256" ]] || usage
[[ "${EUID}" -eq 0 ]] || { echo "bootstrap must run as root" >&2; exit 1; }
[[ "$DEPLOYKIT_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid repository" >&2; exit 2; }
[[ "$DEPLOYKIT_GITHUB_ENVIRONMENT" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$ ]] || { echo "invalid GitHub Environment" >&2; exit 2; }
[[ "$DEPLOYKIT_TARGET_NAME" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "invalid target name" >&2; exit 2; }
[[ "$DEPLOYKIT_TARGET_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "invalid target id" >&2; exit 2; }
[[ "$DEPLOYKIT_BINDING_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "invalid binding id" >&2; exit 2; }
[[ "$DEPLOYKIT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid checksum" >&2; exit 2; }
[[ "$DEPLOYKIT_PACKAGE_NAME" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$ ]] || { echo "invalid package name" >&2; exit 2; }
[[ "$DEPLOYKIT_SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( DEPLOYKIT_SSH_PORT >= 1 && DEPLOYKIT_SSH_PORT <= 65535 )) || {
  echo "invalid SSH port" >&2
  exit 2
}

log() { echo "[deploykit bootstrap] $*" >&2; }
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
    ;;
  arm64)
    DEPLOYKIT_NODE_ARCH="arm64"
    DEPLOYKIT_NODE_SHA256="04fca1b9afecf375f26b41d65d52aa1703a621abea5a8948c7d1e351e85edade"
    ;;
  *) echo "unsupported architecture" >&2; exit 8 ;;
esac

log "installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq openssl dnsutils nginx certbot ufw xz-utils util-linux openssh-client

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
install -d -m 0755 /opt/deploykit
DEPLOYKIT_CLI_STAGE="$(mktemp -d /opt/deploykit/.cli.XXXXXX)"
tar -xzf "$DEPLOYKIT_PACKAGE" --directory "$DEPLOYKIT_CLI_STAGE" --no-same-owner --no-same-permissions
[[ -f "$DEPLOYKIT_CLI_STAGE/package/package.json" && -f "$DEPLOYKIT_CLI_STAGE/package/dist/server-cli.cjs" ]] || {
  echo "DeployKit package does not contain the standalone server runtime" >&2
  exit 9
}
[[ -f "$DEPLOYKIT_CLI_STAGE/package/assets/github-known-hosts" ]] || {
  echo "DeployKit package does not contain the pinned GitHub host keys" >&2
  exit 9
}
DEPLOYKIT_CLI_NAME="$(jq -r '.name' "$DEPLOYKIT_CLI_STAGE/package/package.json")"
DEPLOYKIT_CLI_VERSION="$(jq -r '.version' "$DEPLOYKIT_CLI_STAGE/package/package.json")"
# The expected name arrives from the caller that packed this exact tarball, so
# the installer and the published package can never drift apart again.
[[ "$DEPLOYKIT_CLI_NAME" == "$DEPLOYKIT_PACKAGE_NAME" ]] || {
  echo "unexpected DeployKit package name ${DEPLOYKIT_CLI_NAME}, expected ${DEPLOYKIT_PACKAGE_NAME}" >&2
  exit 9
}
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

install -d -m 0700 /etc/deploykit /etc/deploykit/targets /etc/deploykit/gateway
install -d -m 0755 /var/lib/deploykit /var/lib/deploykit/targets /srv/deploykit /var/log/deploykit /var/lib/deploykit/acme-webroot
install -d -m 0700 /var/lib/deploykit/source
touch /var/lib/deploykit/registry.lock
chmod 0600 /var/lib/deploykit/registry.lock

# ------------------------------------------------------------- host facts --

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
DEPLOYKIT_HOST_FACTS="/etc/deploykit/gateway/host.json"
DEPLOYKIT_HOST_FACTS_TMP="$(mktemp "/etc/deploykit/gateway/.host.XXXXXX")"
jq -n \
  --arg ipv4 "$DEPLOYKIT_PUBLIC_IPV4" \
  --arg ipv6 "$DEPLOYKIT_PUBLIC_IPV6" \
  '{version:1,publicAddresses:([$ipv4,$ipv6]|map(select(length>0))),portRange:{start:20000,end:39999}}' \
  > "$DEPLOYKIT_HOST_FACTS_TMP"
chmod 0644 "$DEPLOYKIT_HOST_FACTS_TMP"
chown root:root "$DEPLOYKIT_HOST_FACTS_TMP"
mv -f "$DEPLOYKIT_HOST_FACTS_TMP" "$DEPLOYKIT_HOST_FACTS"

# ------------------------------------------------------- pinned host keys --

DEPLOYKIT_KNOWN_HOSTS="/etc/deploykit/gateway/github-known-hosts"
install -m 0644 -o root -g root "$DEPLOYKIT_CLI_ROOT/assets/github-known-hosts" "$DEPLOYKIT_KNOWN_HOSTS"

# ------------------------------------------------- gateway account and sudo --

install -d -m 0755 /usr/local/lib/deploykit
install -m 0755 -o root -g root "$DEPLOYKIT_CLI_ROOT/assets/gateway-binding.sh" /usr/local/lib/deploykit/gateway-binding
install -m 0755 -o root -g root "$DEPLOYKIT_CLI_ROOT/assets/gateway-keys.sh" /usr/local/lib/deploykit/gateway-keys

# A system account with no password, no login shell, and no supplementary
# groups. It is deliberately *not* in the docker group: reaching Docker through
# group membership would give anyone who obtained the gateway key root-equivalent
# access without passing through the forced command at all.
if ! id -u "$DEPLOYKIT_GATEWAY_USER" >/dev/null 2>&1; then
  log "creating the ${DEPLOYKIT_GATEWAY_USER} account"
  useradd --system --create-home --home-dir "$DEPLOYKIT_GATEWAY_HOME" \
    --shell /usr/sbin/nologin --comment "DeployKit restricted gateway" "$DEPLOYKIT_GATEWAY_USER"
fi
usermod --shell /usr/sbin/nologin --home "$DEPLOYKIT_GATEWAY_HOME" "$DEPLOYKIT_GATEWAY_USER"
passwd --lock "$DEPLOYKIT_GATEWAY_USER" >/dev/null
if id -nG "$DEPLOYKIT_GATEWAY_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "${DEPLOYKIT_GATEWAY_USER} must not be a member of the docker group" >&2
  exit 9
fi
install -d -m 0755 -o root -g root "$DEPLOYKIT_GATEWAY_HOME"
install -d -m 0700 -o "$DEPLOYKIT_GATEWAY_USER" -g "$DEPLOYKIT_GATEWAY_USER" "$DEPLOYKIT_GATEWAY_HOME/.ssh"
if [[ ! -e "$DEPLOYKIT_GATEWAY_HOME/.ssh/authorized_keys" ]]; then
  install -m 0600 -o "$DEPLOYKIT_GATEWAY_USER" -g "$DEPLOYKIT_GATEWAY_USER" /dev/null "$DEPLOYKIT_GATEWAY_HOME/.ssh/authorized_keys"
fi

# The one program the gateway account may run as root. It takes no arguments and
# execs the forced command frozen in the binding contract.
DEPLOYKIT_ENTRY_TMP="$(mktemp /usr/local/lib/deploykit/.gateway-entry.XXXXXX)"
cat > "$DEPLOYKIT_ENTRY_TMP" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec /usr/local/bin/deploykit gateway
EOF
chmod 0755 "$DEPLOYKIT_ENTRY_TMP"
chown root:root "$DEPLOYKIT_ENTRY_TMP"
mv -f "$DEPLOYKIT_ENTRY_TMP" "$DEPLOYKIT_GATEWAY_ENTRY"

# `env_reset` would strip the SSH_* variables the forced command inspects to
# refuse a client-supplied command, a PTY, and forwarded channels, so exactly
# those four are kept and nothing else. The trailing "" restricts the entry to
# an invocation with no arguments at all.
DEPLOYKIT_SUDOERS="/etc/sudoers.d/deploykit-gateway"
DEPLOYKIT_SUDOERS_TMP="$(mktemp /etc/sudoers.d/.deploykit-gateway.XXXXXX)"
cat > "$DEPLOYKIT_SUDOERS_TMP" <<EOF
Defaults:${DEPLOYKIT_GATEWAY_USER} !requiretty
Defaults:${DEPLOYKIT_GATEWAY_USER} env_reset
Defaults:${DEPLOYKIT_GATEWAY_USER} env_keep += "SSH_ORIGINAL_COMMAND SSH_TTY SSH_AUTH_SOCK DISPLAY XAUTHORITY"
Defaults:${DEPLOYKIT_GATEWAY_USER} secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${DEPLOYKIT_GATEWAY_USER} ALL=(root:root) NOPASSWD: ${DEPLOYKIT_GATEWAY_ENTRY} ""
EOF
chmod 0440 "$DEPLOYKIT_SUDOERS_TMP"
chown root:root "$DEPLOYKIT_SUDOERS_TMP"
visudo -cqf "$DEPLOYKIT_SUDOERS_TMP" || { rm -f "$DEPLOYKIT_SUDOERS_TMP"; echo "generated sudoers entry was rejected" >&2; exit 9; }
mv -f "$DEPLOYKIT_SUDOERS_TMP" "$DEPLOYKIT_SUDOERS"

# ------------------------------------------------------- repository identity --

# The VPS-to-GitHub key is generated here and never leaves the host. It is
# stable: an existing key is reused so a rerun cannot invalidate the deploy key
# already registered on the repository.
DEPLOYKIT_REPOSITORY_KEY="/etc/deploykit/gateway/repository-key"
DEPLOYKIT_REPOSITORY_KEY_ID="deploykit-repository-${DEPLOYKIT_TARGET_ID}"
if [[ ! -f "$DEPLOYKIT_REPOSITORY_KEY" ]]; then
  log "generating the read-only repository key"
  rm -f "$DEPLOYKIT_REPOSITORY_KEY.pub"
  ssh-keygen -q -t ed25519 -N "" -C "$DEPLOYKIT_REPOSITORY_KEY_ID" -f "$DEPLOYKIT_REPOSITORY_KEY"
fi
[[ -f "$DEPLOYKIT_REPOSITORY_KEY" && -f "$DEPLOYKIT_REPOSITORY_KEY.pub" ]] || {
  echo "the repository key pair is incomplete" >&2
  exit 9
}
chmod 0600 "$DEPLOYKIT_REPOSITORY_KEY"
chmod 0644 "$DEPLOYKIT_REPOSITORY_KEY.pub"
chown root:root "$DEPLOYKIT_REPOSITORY_KEY" "$DEPLOYKIT_REPOSITORY_KEY.pub"
DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT="$(ssh-keygen -lf "$DEPLOYKIT_REPOSITORY_KEY.pub" | awk '{print $2}')"
DEPLOYKIT_REPOSITORY_PUBLIC_KEY="$(awk '{printf "%s %s", $1, $2}' "$DEPLOYKIT_REPOSITORY_KEY.pub")"

# ------------------------------------------------------------- the binding --

set +e
DEPLOYKIT_BINDING_RESULT="$(/usr/local/lib/deploykit/gateway-binding \
  --file /etc/deploykit/gateway/binding.json \
  --repository "$DEPLOYKIT_REPOSITORY" \
  --github-environment "$DEPLOYKIT_GITHUB_ENVIRONMENT" \
  --target-name "$DEPLOYKIT_TARGET_NAME" \
  --target-id "$DEPLOYKIT_TARGET_ID" \
  --binding-id "$DEPLOYKIT_BINDING_ID" \
  --runtime-version "$DEPLOYKIT_CLI_VERSION" \
  --runtime-bundle-sha256 "$DEPLOYKIT_SHA256" \
  --repository-key-id "$DEPLOYKIT_REPOSITORY_KEY_ID" \
  --repository-key-fingerprint "$DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT")"
DEPLOYKIT_BINDING_STATUS=$?
set -e
# Exit 4 is the frozen binding-mismatch code; propagate it unchanged so the
# local orchestrator reports DK_GATEWAY_BINDING_MISMATCH rather than a generic
# bootstrap failure.
[[ "$DEPLOYKIT_BINDING_STATUS" -eq 0 ]] || exit "$DEPLOYKIT_BINDING_STATUS"
DEPLOYKIT_BINDING_CHANGED="$(jq -r '.changed' <<<"$DEPLOYKIT_BINDING_RESULT")"

# ------------------------------------------------------- Nginx and Certbot --

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

# ---------------------------------------------------------------- firewall --

if [[ "$DEPLOYKIT_FIREWALL" -eq 1 ]]; then
  log "configuring UFW"
  # Allow the administrator's actual SSH port before enabling the firewall, so
  # reconciling a host that moved sshd off 22 cannot lock the operator out.
  ufw allow OpenSSH
  ufw allow "${DEPLOYKIT_SSH_PORT}/tcp"
  ufw allow 'Nginx Full'
  ufw --force enable
fi

systemctl reload nginx

# ------------------------------------------------------------------ result --

# Nonsecret facts only: the repository *public* key, its fingerprint, and the
# installed identity. No private key, token, or secret value is ever printed.
jq -n -c \
  --argjson changed "$DEPLOYKIT_BINDING_CHANGED" \
  --arg bindingId "$DEPLOYKIT_BINDING_ID" \
  --arg targetId "$DEPLOYKIT_TARGET_ID" \
  --arg gatewayUser "$DEPLOYKIT_GATEWAY_USER" \
  --arg runtimeVersion "$DEPLOYKIT_CLI_VERSION" \
  --arg runtimeBundleSha256 "$DEPLOYKIT_SHA256" \
  --arg repositoryKeyId "$DEPLOYKIT_REPOSITORY_KEY_ID" \
  --arg repositoryPublicKey "$DEPLOYKIT_REPOSITORY_PUBLIC_KEY" \
  --arg repositoryPublicKeyFingerprint "$DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT" \
  '{version:1,changed:$changed,bindingId:$bindingId,targetId:$targetId,gatewayUser:$gatewayUser,runtimeVersion:$runtimeVersion,runtimeBundleSha256:$runtimeBundleSha256,repositoryKeyId:$repositoryKeyId,repositoryPublicKey:$repositoryPublicKey,repositoryPublicKeyFingerprint:$repositoryPublicKeyFingerprint}' \
  | sed 's/^/DEPLOYKIT_BOOTSTRAP_RESULT /'
log "gateway enrollment complete"
