#!/usr/bin/env bash
# Reconciles the root-owned binding that gives one VPS its DeployKit identity.
#
# The binding is the only place the gateway learns which repository, GitHub
# Environment, target, and target ID it serves. A caller that reaches the forced
# command may confirm those values but never choose them, so this script must
# refuse to repoint an existing binding: an identical binding reconciles as a
# no-op, and any disagreement exits 4 (DK_GATEWAY_BINDING_MISMATCH) without
# touching the file.
#
# Runtime version, bundle checksum, and repository-key identity may change on an
# upgrade or a key rotation. Gateway key identifiers are host-owned lifecycle
# state and are always preserved from the existing document.
set -Eeuo pipefail

DEPLOYKIT_BINDING_FILE=""
DEPLOYKIT_REPOSITORY=""
DEPLOYKIT_GITHUB_ENVIRONMENT=""
DEPLOYKIT_TARGET_NAME=""
DEPLOYKIT_TARGET_ID=""
DEPLOYKIT_BINDING_ID=""
DEPLOYKIT_RUNTIME_VERSION=""
DEPLOYKIT_RUNTIME_BUNDLE_SHA256=""
DEPLOYKIT_REPOSITORY_KEY_ID=""
DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT=""

usage() {
  cat >&2 <<'USAGE'
Usage: gateway-binding.sh --file PATH --repository owner/name --github-environment NAME
                          --target-name NAME --target-id ID --binding-id ID
                          --runtime-version VERSION --runtime-bundle-sha256 SHA256
                          --repository-key-id ID --repository-key-fingerprint FINGERPRINT
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) DEPLOYKIT_BINDING_FILE="${2:?}"; shift 2 ;;
    --repository) DEPLOYKIT_REPOSITORY="${2:?}"; shift 2 ;;
    --github-environment) DEPLOYKIT_GITHUB_ENVIRONMENT="${2:?}"; shift 2 ;;
    --target-name) DEPLOYKIT_TARGET_NAME="${2:?}"; shift 2 ;;
    --target-id) DEPLOYKIT_TARGET_ID="${2:?}"; shift 2 ;;
    --binding-id) DEPLOYKIT_BINDING_ID="${2:?}"; shift 2 ;;
    --runtime-version) DEPLOYKIT_RUNTIME_VERSION="${2:?}"; shift 2 ;;
    --runtime-bundle-sha256) DEPLOYKIT_RUNTIME_BUNDLE_SHA256="${2:?}"; shift 2 ;;
    --repository-key-id) DEPLOYKIT_REPOSITORY_KEY_ID="${2:?}"; shift 2 ;;
    --repository-key-fingerprint) DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$DEPLOYKIT_BINDING_FILE" ]] || usage
[[ "$DEPLOYKIT_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid repository" >&2; exit 2; }
[[ "$DEPLOYKIT_GITHUB_ENVIRONMENT" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$ ]] || { echo "invalid GitHub Environment" >&2; exit 2; }
[[ "$DEPLOYKIT_TARGET_NAME" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "invalid target name" >&2; exit 2; }
[[ "$DEPLOYKIT_TARGET_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "invalid target id" >&2; exit 2; }
[[ "$DEPLOYKIT_BINDING_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "invalid binding id" >&2; exit 2; }
[[ "$DEPLOYKIT_RUNTIME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || { echo "invalid runtime version" >&2; exit 2; }
[[ "$DEPLOYKIT_RUNTIME_BUNDLE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid runtime bundle checksum" >&2; exit 2; }
[[ "$DEPLOYKIT_REPOSITORY_KEY_ID" =~ ^[A-Za-z0-9_.-]{1,255}$ ]] || { echo "invalid repository key id" >&2; exit 2; }
[[ "$DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || { echo "invalid repository key fingerprint" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || { echo "jq is required to reconcile the gateway binding" >&2; exit 9; }

DEPLOYKIT_ACTIVE_KEY_ID=""
DEPLOYKIT_PENDING_KEY_ID=""

if [[ -e "$DEPLOYKIT_BINDING_FILE" ]]; then
  if [[ -L "$DEPLOYKIT_BINDING_FILE" || ! -f "$DEPLOYKIT_BINDING_FILE" ]]; then
    echo "the gateway binding at $DEPLOYKIT_BINDING_FILE is not a regular file" >&2
    exit 9
  fi
  DEPLOYKIT_MISMATCH="$(jq -r \
    --arg repository "$DEPLOYKIT_REPOSITORY" \
    --arg githubEnvironment "$DEPLOYKIT_GITHUB_ENVIRONMENT" \
    --arg targetName "$DEPLOYKIT_TARGET_NAME" \
    --arg targetId "$DEPLOYKIT_TARGET_ID" \
    --arg bindingId "$DEPLOYKIT_BINDING_ID" \
    '. as $current
     | [["repository",$repository],["githubEnvironment",$githubEnvironment],["targetName",$targetName],["targetId",$targetId],["bindingId",$bindingId]]
     | map(select($current[.[0]] != .[1]) | .[0])
     | join(",")' \
    "$DEPLOYKIT_BINDING_FILE" 2>/dev/null)" || {
      echo "the gateway binding at $DEPLOYKIT_BINDING_FILE is not parsable JSON" >&2
      exit 9
    }
  if [[ -n "$DEPLOYKIT_MISMATCH" ]]; then
    echo "the existing gateway binding names a different ${DEPLOYKIT_MISMATCH}; refusing to repoint this host" >&2
    exit 4
  fi
  DEPLOYKIT_ACTIVE_KEY_ID="$(jq -r '.activeGatewayKeyId // empty' "$DEPLOYKIT_BINDING_FILE")"
  DEPLOYKIT_PENDING_KEY_ID="$(jq -r '.pendingGatewayKeyId // empty' "$DEPLOYKIT_BINDING_FILE")"
fi

DEPLOYKIT_BINDING_TMP="$(mktemp "${DEPLOYKIT_BINDING_FILE}.XXXXXX")"
trap 'rm -f "$DEPLOYKIT_BINDING_TMP"' EXIT

# The key order below is the frozen gateway-binding contract order; jq preserves
# object literal insertion order, so the written bytes stay deterministic.
jq -n \
  --arg bindingId "$DEPLOYKIT_BINDING_ID" \
  --arg repository "$DEPLOYKIT_REPOSITORY" \
  --arg githubEnvironment "$DEPLOYKIT_GITHUB_ENVIRONMENT" \
  --arg targetName "$DEPLOYKIT_TARGET_NAME" \
  --arg targetId "$DEPLOYKIT_TARGET_ID" \
  --arg runtimeVersion "$DEPLOYKIT_RUNTIME_VERSION" \
  --arg runtimeBundleSha256 "$DEPLOYKIT_RUNTIME_BUNDLE_SHA256" \
  --arg repositoryKeyId "$DEPLOYKIT_REPOSITORY_KEY_ID" \
  --arg repositoryKeyFingerprint "$DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT" \
  --arg activeGatewayKeyId "$DEPLOYKIT_ACTIVE_KEY_ID" \
  --arg pendingGatewayKeyId "$DEPLOYKIT_PENDING_KEY_ID" \
  '{
     apiVersion: "deploykit/gateway-binding/v1alpha1",
     bindingId: $bindingId,
     repository: $repository,
     githubEnvironment: $githubEnvironment,
     targetName: $targetName,
     targetId: $targetId,
     gatewayUser: "deploykit-gateway",
     forcedCommand: "deploykit gateway",
     runtimeVersion: $runtimeVersion,
     runtimeBundleSha256: $runtimeBundleSha256,
     repositoryKeyId: $repositoryKeyId,
     repositoryKeyFingerprint: $repositoryKeyFingerprint,
     activeGatewayKeyId: (if $activeGatewayKeyId == "" then null else $activeGatewayKeyId end),
     pendingGatewayKeyId: (if $pendingGatewayKeyId == "" then null else $pendingGatewayKeyId end)
   }' > "$DEPLOYKIT_BINDING_TMP"

DEPLOYKIT_BINDING_CHANGED=true
if [[ -f "$DEPLOYKIT_BINDING_FILE" ]] && cmp -s "$DEPLOYKIT_BINDING_TMP" "$DEPLOYKIT_BINDING_FILE"; then
  DEPLOYKIT_BINDING_CHANGED=false
else
  chmod 0644 "$DEPLOYKIT_BINDING_TMP"
  if [[ "${EUID}" -eq 0 ]]; then chown root:root "$DEPLOYKIT_BINDING_TMP"; fi
  mv -f "$DEPLOYKIT_BINDING_TMP" "$DEPLOYKIT_BINDING_FILE"
fi

printf '{"changed":%s}\n' "$DEPLOYKIT_BINDING_CHANGED"
