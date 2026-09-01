#!/usr/bin/env bash
# Manages the DeployKit-owned forced-command entries in the gateway user's
# authorized_keys file.
#
# Rotation has to survive an interruption at every step, so a key is *staged*
# before it is *activated* and only the previous DeployKit-owned entry for the
# same binding is ever removed. An owned entry is identified by its comment
# field alone:
#
#     deploykit-gateway:<bindingId>:<state>:<keyId>
#
# Any line whose comment does not carry this binding's prefix belongs to the
# operator or to another target sharing the host, and this script never reads
# meaning into it, rewrites it, or drops it.
set -Eeuo pipefail

DEPLOYKIT_AUTHORIZED_KEYS=""
DEPLOYKIT_BINDING_ID=""
DEPLOYKIT_KEY_ID=""
DEPLOYKIT_PUBLIC_KEY_FILE=""
DEPLOYKIT_OWNER=""
DEPLOYKIT_COMMAND="/usr/bin/sudo -n /usr/local/lib/deploykit/gateway-entry"
DEPLOYKIT_ACTION=""

# `restrict` is the whole policy on a current OpenSSH; the explicit negations
# repeat it so an older sshd that does not understand `restrict` still refuses
# a PTY and every forwarding channel rather than silently allowing them.
DEPLOYKIT_KEY_OPTIONS="restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding"

usage() {
  cat >&2 <<'USAGE'
Usage: gateway-keys.sh --authorized-keys PATH --binding-id ID [--owner USER] [--command CMD] ACTION [options]

Actions:
  stage    --key-id ID --public-key-file PATH   append a pending owned entry ("-" reads stdin)
  activate --key-id ID                          promote one entry and drop the other owned entries
  prune                                         drop this binding's pending owned entries
  list                                          print this binding's owned entries as JSON lines
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --authorized-keys) DEPLOYKIT_AUTHORIZED_KEYS="${2:?}"; shift 2 ;;
    --binding-id) DEPLOYKIT_BINDING_ID="${2:?}"; shift 2 ;;
    --key-id) DEPLOYKIT_KEY_ID="${2:?}"; shift 2 ;;
    --public-key-file) DEPLOYKIT_PUBLIC_KEY_FILE="${2:?}"; shift 2 ;;
    --owner) DEPLOYKIT_OWNER="${2:?}"; shift 2 ;;
    --command) DEPLOYKIT_COMMAND="${2:?}"; shift 2 ;;
    stage|activate|prune|list)
      [[ -z "$DEPLOYKIT_ACTION" ]] || usage
      DEPLOYKIT_ACTION="$1"; shift ;;
    *) usage ;;
  esac
done

[[ -n "$DEPLOYKIT_AUTHORIZED_KEYS" && -n "$DEPLOYKIT_ACTION" ]] || usage
[[ "$DEPLOYKIT_BINDING_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "invalid binding id" >&2; exit 2; }
[[ "$DEPLOYKIT_COMMAND" != *'"'* && "$DEPLOYKIT_COMMAND" != *$'\n'* ]] || { echo "invalid forced command" >&2; exit 2; }

DEPLOYKIT_OWNED_PREFIX="deploykit-gateway:${DEPLOYKIT_BINDING_ID}:"

if [[ -L "$DEPLOYKIT_AUTHORIZED_KEYS" ]]; then
  echo "the gateway authorized_keys file is a symlink" >&2
  exit 9
fi
if [[ ! -e "$DEPLOYKIT_AUTHORIZED_KEYS" ]]; then
  install -m 0600 /dev/null "$DEPLOYKIT_AUTHORIZED_KEYS"
fi

# Rewrites the file atomically from stdin, preserving mode and ownership.
commit_lines() {
  local tmp
  tmp="$(mktemp "${DEPLOYKIT_AUTHORIZED_KEYS}.XXXXXX")"
  cat > "$tmp"
  chmod 0600 "$tmp"
  if [[ "${EUID}" -eq 0 && -n "$DEPLOYKIT_OWNER" ]]; then chown "$DEPLOYKIT_OWNER" "$tmp"; fi
  mv -f "$tmp" "$DEPLOYKIT_AUTHORIZED_KEYS"
}

# Prints every line except this binding's owned entries matching $1 (a state, or
# the empty string for every state).
without_owned() {
  awk -v prefix="$DEPLOYKIT_OWNED_PREFIX" -v state="$1" '
    {
      marker = $NF
      if (index(marker, prefix) == 1) {
        rest = substr(marker, length(prefix) + 1)
        split(rest, parts, ":")
        if (state == "" || parts[1] == state) next
      }
      print
    }
  ' "$DEPLOYKIT_AUTHORIZED_KEYS"
}

owned_line_for_key() {
  awk -v prefix="$DEPLOYKIT_OWNED_PREFIX" -v keyId="$1" '
    {
      marker = $NF
      if (index(marker, prefix) != 1) next
      rest = substr(marker, length(prefix) + 1)
      split(rest, parts, ":")
      if (parts[2] == keyId) { print; exit }
    }
  ' "$DEPLOYKIT_AUTHORIZED_KEYS"
}

case "$DEPLOYKIT_ACTION" in
  stage)
    [[ "$DEPLOYKIT_KEY_ID" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { echo "invalid key id" >&2; exit 2; }
    [[ -n "$DEPLOYKIT_PUBLIC_KEY_FILE" ]] || { echo "public key file is required" >&2; exit 2; }
    # `-` reads the key from stdin, which is how the orchestrator supplies it:
    # a pipe can only be consumed once, so the whole line is captured here and
    # every later check reads the captured value rather than the source again.
    if [[ "$DEPLOYKIT_PUBLIC_KEY_FILE" == "-" ]]; then
      IFS= read -r DEPLOYKIT_PUBLIC_KEY || true
    else
      [[ -f "$DEPLOYKIT_PUBLIC_KEY_FILE" && ! -L "$DEPLOYKIT_PUBLIC_KEY_FILE" ]] || {
        echo "public key file is not a regular file" >&2
        exit 2
      }
      IFS= read -r DEPLOYKIT_PUBLIC_KEY < "$DEPLOYKIT_PUBLIC_KEY_FILE" || true
    fi
    read -r DEPLOYKIT_KEY_TYPE DEPLOYKIT_KEY_DATA _ <<<"$DEPLOYKIT_PUBLIC_KEY"
    case "$DEPLOYKIT_KEY_TYPE" in
      ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) ;;
      *) echo "unsupported gateway key type" >&2; exit 2 ;;
    esac
    [[ "$DEPLOYKIT_KEY_DATA" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || { echo "malformed gateway public key" >&2; exit 2; }
    {
      # Dropping this binding's pending entries first makes a repeated stage of
      # the same or a replacement key idempotent; the active entry is untouched,
      # so an interruption here always leaves the proven key in place.
      without_owned pending | awk -v prefix="$DEPLOYKIT_OWNED_PREFIX" -v keyId="$DEPLOYKIT_KEY_ID" '
        {
          marker = $NF
          if (index(marker, prefix) == 1) {
            rest = substr(marker, length(prefix) + 1)
            split(rest, parts, ":")
            if (parts[2] == keyId) next
          }
          print
        }
      '
      printf '%s,command="%s" %s %s %spending:%s\n' \
        "$DEPLOYKIT_KEY_OPTIONS" "$DEPLOYKIT_COMMAND" "$DEPLOYKIT_KEY_TYPE" "$DEPLOYKIT_KEY_DATA" \
        "$DEPLOYKIT_OWNED_PREFIX" "$DEPLOYKIT_KEY_ID"
    } | commit_lines
    printf '{"action":"stage","keyId":"%s","state":"pending"}\n' "$DEPLOYKIT_KEY_ID"
    ;;

  activate)
    [[ "$DEPLOYKIT_KEY_ID" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { echo "invalid key id" >&2; exit 2; }
    DEPLOYKIT_TARGET_LINE="$(owned_line_for_key "$DEPLOYKIT_KEY_ID")"
    if [[ -z "$DEPLOYKIT_TARGET_LINE" ]]; then
      echo "no DeployKit-owned entry for key ${DEPLOYKIT_KEY_ID} is present; the last verified key was left intact" >&2
      exit 9
    fi
    {
      without_owned ""
      printf '%s %sactive:%s\n' "${DEPLOYKIT_TARGET_LINE% *}" "$DEPLOYKIT_OWNED_PREFIX" "$DEPLOYKIT_KEY_ID"
    } | commit_lines
    printf '{"action":"activate","keyId":"%s","state":"active"}\n' "$DEPLOYKIT_KEY_ID"
    ;;

  prune)
    without_owned pending | commit_lines
    printf '{"action":"prune"}\n'
    ;;

  list)
    awk -v prefix="$DEPLOYKIT_OWNED_PREFIX" '
      {
        marker = $NF
        if (index(marker, prefix) != 1) next
        rest = substr(marker, length(prefix) + 1)
        split(rest, parts, ":")
        printf "{\"state\":\"%s\",\"keyId\":\"%s\",\"type\":\"%s\",\"key\":\"%s\"}\n", parts[1], parts[2], $(NF-2), $(NF-1)
      }
    ' "$DEPLOYKIT_AUTHORIZED_KEYS"
    ;;
esac
