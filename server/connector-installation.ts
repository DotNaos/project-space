import type { IncomingMessage } from 'node:http';

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
  environment: NodeJS.ProcessEnv = process.env
): ConnectorInstallerReleaseConfig {
  const version = environment.PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION?.trim() ?? '';
  const asset = environment.PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET?.trim() ?? '';
  const sha256 = environment.PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256?.trim().toLowerCase() ?? '';

  if (!bundleVersionPattern.test(version) || version.toLowerCase() === 'latest') {
    throw new Error(
      'PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION must pin an exact release tag.'
    );
  }
  if (!bundleAssetPattern.test(asset)) {
    throw new Error('PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET has an invalid archive name.');
  }
  const semanticVersion = version.slice(1);
  if (asset !== `project-space-machine-tools-darwin-arm64-v${semanticVersion}.tar.gz`) {
    throw new Error('PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET must match the pinned release tag.');
  }
  if (!sha256Pattern.test(sha256)) {
    throw new Error(
      'PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256 must pin the release archive checksum.'
    );
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

export async function createConnectorInstaller(origin: string) {
  const release = connectorInstallerReleaseConfig();

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

bundle_root="$tmp_dir/\${bundle_asset%.tar.gz}"
tar -xzf "$archive" -C "$tmp_dir"
if [ ! -d "$bundle_root" ] || [ -L "$bundle_root" ] ||
   [ ! -x "$bundle_root/install.sh" ] ||
   [ ! -f "$bundle_root/project-space-connector" ] ||
   [ ! -f "$bundle_root/project" ] ||
   [ ! -f "$bundle_root/connector-command-signing-public-key.pem" ] ||
   [ ! -f "$bundle_root/release-manifest-signing-public-key.pem" ]; then
  echo "Connector bundle must contain one complete versioned machine-tools directory."
  exit 1
fi
legacy_plist="$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist"
managed_plist="$HOME/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist"
if [ -f "$legacy_plist" ] && [ -f "$managed_plist" ]; then
  echo "Both legacy and managed connector services exist. Resolve that conflict before reinstalling."
  exit 1
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
