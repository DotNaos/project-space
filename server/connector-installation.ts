import type { IncomingMessage } from 'node:http';

import {
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseArtifact,
  type ConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';
import {
  ConnectorRuntimeReleaseSourceError,
  GitHubConnectorRuntimeReleaseSource,
  configuredConnectorRuntimeReleaseId,
  configuredConnectorRuntimeReleasePublicKey
} from './connector-runtime-release-source';

function safeShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const defaultPublicOrigin = 'https://projects.os-home.net';
const publicHostPattern = /^(?:localhost|[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;
const bundleVersionPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const bundleAssetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;

export interface ConnectorInstallerReleaseConfig {
  asset: string;
  sha256: string;
  version: string;
}

export function connectorInstallerReleaseConfig(
  manifest: Pick<ConnectorRuntimeReleaseManifest, 'releaseId' | 'version'>,
  artifact: Pick<ConnectorRuntimeReleaseArtifact, 'assetName' | 'sha256'>
): ConnectorInstallerReleaseConfig {
  const version = manifest.releaseId.trim();
  const asset = artifact.assetName.trim();
  const sha256 = artifact.sha256.trim().toLowerCase();

  if (
    !bundleVersionPattern.test(version) ||
    version !== `v${manifest.version}` ||
    version.toLowerCase() === 'latest'
  ) {
    throw new Error('The approved release manifest must pin one exact release tag.');
  }
  if (!bundleAssetPattern.test(asset)) {
    throw new Error('The approved release manifest has an invalid archive name.');
  }
  const semanticVersion = version.slice(1);
  if (asset !== `project-space-machine-tools-darwin-arm64-v${semanticVersion}.tar.gz`) {
    throw new Error('The approved macOS archive must match the pinned release tag.');
  }
  if (!sha256Pattern.test(sha256)) {
    throw new Error('The approved macOS archive must pin one SHA-256 checksum.');
  }

  return { asset, sha256, version };
}

function normalizePublicOrigin(value: string) {
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !publicHostPattern.test(url.host) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function requestPublicOrigin(request: IncomingMessage) {
  const configuredOrigin = process.env.PROJECT_SPACE_PUBLIC_ORIGIN?.trim();
  if (configuredOrigin) {
    const normalized = normalizePublicOrigin(configuredOrigin);
    if (!normalized) {
      throw new Error('PROJECT_SPACE_PUBLIC_ORIGIN must be a plain HTTP or HTTPS origin.');
    }
    return normalized;
  }

  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const proto = request.headers['x-forwarded-proto'] ??
    ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const firstHost = Array.isArray(host) ? host[0] : String(host).split(',')[0]?.trim();
  const firstProto = Array.isArray(proto) ? proto[0] : String(proto).split(',')[0]?.trim();
  return normalizePublicOrigin(`${firstProto}://${firstHost}`) ?? defaultPublicOrigin;
}

export function connectorInstallUrl(origin: string) {
  return new URL('/connector/install.sh', origin).toString();
}

function connectorInstallCommand(
  origin: string,
  release: ConnectorInstallerReleaseConfig
) {
  return [
    `curl -fsSL ${safeShellSingleQuoted(connectorInstallUrl(origin))} |`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION=${safeShellSingleQuoted(release.version)}`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET=${safeShellSingleQuoted(release.asset)}`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256=${safeShellSingleQuoted(release.sha256)}`,
    'bash'
  ].join(' ');
}

interface ConnectorInstallerReleaseSource {
  loadApprovedManifest(requestedReleaseId?: string): Promise<unknown>;
}

export interface CreateConnectorInstallerOptions {
  environment?: NodeJS.ProcessEnv;
  manifestPublicKey?: Parameters<typeof verifyConnectorRuntimeReleaseManifest>[1];
  now?: number;
  releases?: ConnectorInstallerReleaseSource;
}

export async function createConnectorInstaller(
  origin: string,
  options: CreateConnectorInstallerOptions = {}
) {
  const environment = options.environment ?? process.env;
  const releaseId = configuredConnectorRuntimeReleaseId(environment);
  const manifestPublicKey =
    options.manifestPublicKey ?? configuredConnectorRuntimeReleasePublicKey(environment);
  if (!releaseId || !manifestPublicKey) {
    throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
  }
  const releases = options.releases ?? new GitHubConnectorRuntimeReleaseSource(releaseId);
  const rawManifest = await releases.loadApprovedManifest(releaseId);
  const manifest = verifyConnectorRuntimeReleaseManifest(
    rawManifest,
    manifestPublicKey,
    options.now === undefined ? {} : { now: options.now }
  );
  const artifact = resolveConnectorRuntimeReleaseArtifact(
    manifest,
    'darwin-arm64',
    releaseId
  );
  const release = connectorInstallerReleaseConfig(manifest, artifact);

  return {
    command: connectorInstallCommand(origin, release),
    scriptUrl: connectorInstallUrl(origin)
  };
}

export function connectorInstallScript(origin: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

hub_url=${safeShellSingleQuoted(origin)}
bundle_version="\${PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION:-}"
bundle_asset="\${PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:-}"
bundle_sha256="\${PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256:-}"
install_dir="\${PROJECT_SPACE_CONNECTOR_DIR:-$HOME/.local/bin}"
service_name="\${PROJECT_CONNECTOR_SERVICE_NAME:-$(hostname -s)}"

if [ -z "$bundle_version" ] || [ -z "$bundle_asset" ] || [ -z "$bundle_sha256" ]; then
  echo "Generate a managed install command from Project Space first."
  exit 1
fi

if [[ ! "$bundle_version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
   [[ ! "$bundle_asset" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$ ]] ||
   [[ ! "$bundle_sha256" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "The account-specific installer has invalid release metadata. Generate a new command."
  exit 1
fi

expected_asset="project-space-machine-tools-darwin-arm64-$bundle_version.tar.gz"
if [ "$bundle_asset" != "$expected_asset" ]; then
  echo "The connector archive does not match the pinned release. Generate a new command."
  exit 1
fi

download_url="https://github.com/DotNaos/project-space/releases/download/$bundle_version/$bundle_asset"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Project Space currently publishes a packaged connector for macOS arm64."
  echo "For this machine, build from source or install a matching connector binary, then run:"
  echo "project connect"
  exit 1
fi

mkdir -p "$install_dir"
umask 077
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

archive="$tmp_dir/$bundle_asset"
curl -fsSL "$download_url" -o "$archive"
actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [ "$actual_sha256" != "$bundle_sha256" ]; then
  echo "Connector bundle checksum mismatch; nothing was installed."
  exit 1
fi

reject_bundle() {
  echo "Connector bundle must contain one complete, unambiguous versioned machine-tools directory."
  exit 1
}

expected_bundle_root="\${bundle_asset%.tar.gz}"
archive_members="$tmp_dir/archive-members.txt"
if ! LC_ALL=C tar -tzf "$archive" > "$archive_members"; then
  reject_bundle
fi

bundle_root_name=""
root_directory_count=0
checksums_count=0
version_count=0
command_key_count=0
install_script_count=0
project_count=0
approval_signer_count=0
connector_count=0
release_key_count=0

while IFS= read -r member || [ -n "$member" ]; do
  [ -n "$member" ] || reject_bundle
  case "$member" in
    /*|../*|*/../*|*/..|./*|*/./*|*/.|*//*) reject_bundle ;;
  esac

  normalized_member="\${member%/}"
  candidate_root="\${normalized_member%%/*}"
  if [ "$candidate_root" != "$expected_bundle_root" ]; then
    reject_bundle
  fi
  if [ -z "$bundle_root_name" ]; then
    bundle_root_name="$candidate_root"
  elif [ "$candidate_root" != "$bundle_root_name" ]; then
    reject_bundle
  fi

  case "$normalized_member" in
    "$candidate_root")
      [[ "$member" == */ ]] || reject_bundle
      root_directory_count=$((root_directory_count + 1))
      ;;
    "$candidate_root/SHA256SUMS.txt") checksums_count=$((checksums_count + 1)) ;;
    "$candidate_root/VERSION") version_count=$((version_count + 1)) ;;
    "$candidate_root/connector-command-signing-public-key.pem")
      command_key_count=$((command_key_count + 1))
      ;;
    "$candidate_root/install.sh") install_script_count=$((install_script_count + 1)) ;;
    "$candidate_root/project") project_count=$((project_count + 1)) ;;
    "$candidate_root/project-approval-signer")
      approval_signer_count=$((approval_signer_count + 1))
      ;;
    "$candidate_root/project-space-connector") connector_count=$((connector_count + 1)) ;;
    "$candidate_root/release-manifest-signing-public-key.pem")
      release_key_count=$((release_key_count + 1))
      ;;
    *) reject_bundle ;;
  esac
done < "$archive_members"

if [ "$bundle_root_name" != "$expected_bundle_root" ] ||
   [ "$root_directory_count" -gt 1 ] ||
   [ "$checksums_count" -ne 1 ] ||
   [ "$version_count" -ne 1 ] ||
   [ "$command_key_count" -ne 1 ] ||
   [ "$install_script_count" -ne 1 ] ||
   [ "$project_count" -ne 1 ] ||
   [ "$approval_signer_count" -ne 1 ] ||
   [ "$connector_count" -ne 1 ] ||
   [ "$release_key_count" -ne 1 ]; then
  reject_bundle
fi

extract_root="$tmp_dir/extracted"
bundle_root="$extract_root/$bundle_root_name"
mkdir -p "$bundle_root"
extract_bundle_member() {
  member_name=$1
  member_mode=$2
  destination="$bundle_root/$member_name"
  if ! tar -xOzf "$archive" "$bundle_root_name/$member_name" > "$destination" ||
     [ ! -s "$destination" ]; then
    reject_bundle
  fi
  chmod "$member_mode" "$destination"
}

extract_bundle_member SHA256SUMS.txt 0644
extract_bundle_member VERSION 0644
extract_bundle_member connector-command-signing-public-key.pem 0644
extract_bundle_member install.sh 0755
extract_bundle_member project 0755
extract_bundle_member project-approval-signer 0755
extract_bundle_member project-space-connector 0755
extract_bundle_member release-manifest-signing-public-key.pem 0644

legacy_plist="$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist"
managed_plist="$HOME/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist"
if [ -f "$legacy_plist" ] && [ -f "$managed_plist" ]; then
  echo "Both connector services exist. The managed identity will be preserved and the legacy service will be removed after a healthy reconnect."
fi
if [ -f "$legacy_plist" ] && [ ! -f "$managed_plist" ]; then
  echo "This machine still uses a legacy connector identity."
  echo "Automatic replacement is blocked because that identity cannot be preserved safely."
  echo "Remove or revoke the legacy connector explicitly, then run this command again to enroll with project connect."
  exit 1
fi

"$bundle_root/install.sh" --install-dir "$install_dir"

if [ -f "$managed_plist" ] && [ ! -f "$legacy_plist" ]; then
  echo "Project Space managed machine tools reinstalled; the existing machine identity and settings were preserved."
  echo "Bundle: $bundle_version/$bundle_asset"
  exit 0
fi

echo "The verified managed machine tools are installed. Approve the machine to finish setup."
PROJECT_CONNECTOR_SERVICE_NAME="$service_name" "$install_dir/project" connect
if [ ! -f "$managed_plist" ]; then
  echo "The managed connector service was not installed."
  exit 1
fi
echo "Project Space managed connector installed and connected."
`;
}
