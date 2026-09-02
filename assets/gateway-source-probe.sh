#!/usr/bin/env bash
# Proves the VPS-held read-only repository key reaches exactly the bound private
# repository, through the pinned GitHub host keys and nothing else.
#
# Two facts are established here and the second one is the reason this script
# exists. `git ls-remote` shows the key can read *a* repository. GitHub's own SSH
# greeting shows *which* repository it authenticates as — a deploy key is
# answered with `Hi owner/name!`, a user key with a bare login — so a key that
# would in fact open some other repository is refused now, rather than
# discovered later when the gateway has already been trusted to fetch source.
#
# Nothing is written. The key is read where the installer left it, mode 0600 and
# root-owned, and never leaves the host.
set -Eeuo pipefail

DEPLOYKIT_REPOSITORY=""
DEPLOYKIT_KEY="/etc/deploykit/gateway/repository-key"
DEPLOYKIT_KNOWN_HOSTS="/etc/deploykit/gateway/github-known-hosts"
DEPLOYKIT_SSH_HOST="git@github.com"
DEPLOYKIT_CONNECT_TIMEOUT=15

usage() {
  cat >&2 <<'USAGE'
Usage: gateway-source-probe.sh --repository owner/name [--key PATH] [--known-hosts PATH]

Exit codes:
  0  the key reached the bound repository and authenticates as it
  5  the key authenticates as a different identity than the bound repository
  9  the key could not reach the bound repository
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository) DEPLOYKIT_REPOSITORY="${2:?}"; shift 2 ;;
    --key) DEPLOYKIT_KEY="${2:?}"; shift 2 ;;
    --known-hosts) DEPLOYKIT_KNOWN_HOSTS="${2:?}"; shift 2 ;;
    --ssh-host) DEPLOYKIT_SSH_HOST="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$DEPLOYKIT_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "invalid repository" >&2; usage; }

# A symlink here would let anything that can write /etc/deploykit choose which
# private key the probe — and therefore the gateway — is judged on.
[[ -f "$DEPLOYKIT_KEY" && ! -L "$DEPLOYKIT_KEY" ]] || { echo "the repository key is not a regular file" >&2; exit 9; }
[[ -f "$DEPLOYKIT_KEY.pub" && ! -L "$DEPLOYKIT_KEY.pub" ]] || { echo "the repository public key is missing" >&2; exit 9; }
[[ -f "$DEPLOYKIT_KNOWN_HOSTS" && ! -L "$DEPLOYKIT_KNOWN_HOSTS" ]] || { echo "the pinned GitHub host keys are missing" >&2; exit 9; }

DEPLOYKIT_KEY_FINGERPRINT="$(ssh-keygen -lf "$DEPLOYKIT_KEY.pub" | awk '{print $2}')"
[[ "$DEPLOYKIT_KEY_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || { echo "unreadable repository key fingerprint" >&2; exit 9; }

# `StrictHostKeyChecking=yes` against the pinned file only: no global file, no
# agent, no password prompt, and no identity but this one.
DEPLOYKIT_SSH_ARGS=(
  -o "StrictHostKeyChecking=yes"
  -o "UserKnownHostsFile=${DEPLOYKIT_KNOWN_HOSTS}"
  -o "GlobalKnownHostsFile=/dev/null"
  -o "IdentitiesOnly=yes"
  -o "IdentityAgent=none"
  -o "IdentityFile=${DEPLOYKIT_KEY}"
  -o "BatchMode=yes"
  -o "PasswordAuthentication=no"
  -o "ConnectTimeout=${DEPLOYKIT_CONNECT_TIMEOUT}"
)

# GitHub always closes this session with a non-zero status; the greeting on
# stderr is the whole payload, so failure is read from the greeting, not $?.
set +e
DEPLOYKIT_GREETING="$(ssh "${DEPLOYKIT_SSH_ARGS[@]}" -T "$DEPLOYKIT_SSH_HOST" 2>&1)"
set -e
DEPLOYKIT_IDENTITY="$(sed -n 's/^Hi \(.*\)! You.*$/\1/p' <<<"$DEPLOYKIT_GREETING" | head -n 1)"
if [[ -z "$DEPLOYKIT_IDENTITY" ]]; then
  echo "the repository key was not accepted by ${DEPLOYKIT_SSH_HOST}" >&2
  exit 9
fi
if [[ "$DEPLOYKIT_IDENTITY" != "$DEPLOYKIT_REPOSITORY" ]]; then
  # Either the key is a user key with repository-wide reach, or it is a deploy
  # key belonging to some other repository. Both would let the gateway fetch
  # source DeployKit never bound it to.
  echo "the repository key authenticates as ${DEPLOYKIT_IDENTITY}, not ${DEPLOYKIT_REPOSITORY}" >&2
  exit 5
fi

DEPLOYKIT_SSH_COMMAND="ssh"
for DEPLOYKIT_SSH_ARG in "${DEPLOYKIT_SSH_ARGS[@]}"; do
  DEPLOYKIT_SSH_COMMAND+=" $(printf '%q' "$DEPLOYKIT_SSH_ARG")"
done

set +e
GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$DEPLOYKIT_SSH_COMMAND" \
  git ls-remote --quiet -- "${DEPLOYKIT_SSH_HOST}:${DEPLOYKIT_REPOSITORY}.git" HEAD >/dev/null 2>&1
DEPLOYKIT_LS_REMOTE_STATUS=$?
set -e
if [[ "$DEPLOYKIT_LS_REMOTE_STATUS" -ne 0 ]]; then
  echo "the repository key could not fetch ${DEPLOYKIT_REPOSITORY}" >&2
  exit 9
fi

printf 'DEPLOYKIT_SOURCE_PROBE {"version":1,"repository":"%s","authenticatedAs":"%s","keyFingerprint":"%s","reachable":true}\n' \
  "$DEPLOYKIT_REPOSITORY" "$DEPLOYKIT_IDENTITY" "$DEPLOYKIT_KEY_FINGERPRINT"
