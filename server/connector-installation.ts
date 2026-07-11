import { createPublicKey, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

import {
  createConnectorCredential,
  isDatabaseConfigured
} from './local-database-store';

function safeShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const defaultPublicOrigin = 'https://projects.os-home.net';
const publicHostPattern = /^(?:localhost|[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;
export const connectorEnrollmentTtlSeconds = 15 * 60;
const defaultBundleAsset = 'project-space-machine-tools-darwin-arm64.tar.gz';
const bundleVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
  const asset =
    environment.PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET?.trim() || defaultBundleAsset;
  const sha256 = environment.PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256?.trim().toLowerCase() ?? '';

  if (!bundleVersionPattern.test(version) || version.toLowerCase() === 'latest') {
    throw new Error(
      'PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION must pin an exact release tag.'
    );
  }
  if (!bundleAssetPattern.test(asset)) {
    throw new Error('PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET has an invalid archive name.');
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

function connectorCommandSigningPublicKey() {
  const encodedPrivateKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64?.trim();
  const decodedPrivateKey = encodedPrivateKey
    ? Buffer.from(encodedPrivateKey, 'base64').toString('utf8').trim()
    : '';
  const privateKey =
    decodedPrivateKey ||
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY?.trim() ||
    (() => {
      const path = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_FILE?.trim();
      return path && existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    })();

  if (privateKey) {
    try {
      return createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString().trim();
    } catch {
      return '';
    }
  }

  const inline = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY?.trim();
  if (inline) {
    return inline;
  }
  const path = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY_FILE?.trim();
  if (path && existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  return '';
}

function connectorInstallCommand(
  origin: string,
  credential: string,
  publicKey: string,
  machineId: string,
  release: ConnectorInstallerReleaseConfig
) {
  const encodedPublicKey = Buffer.from(publicKey, 'utf8').toString('base64');
  return [
    `curl -fsSL ${safeShellSingleQuoted(connectorInstallUrl(origin))} |`,
    `PROJECT_CONNECTOR_ENROLLMENT_CREDENTIAL=${safeShellSingleQuoted(credential)}`,
    `PROJECT_CONNECTOR_COMMAND_PUBLIC_KEY_B64=${safeShellSingleQuoted(encodedPublicKey)}`,
    `PROJECT_CONNECTOR_ASSIGNED_MACHINE_ID=${safeShellSingleQuoted(machineId)}`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION=${safeShellSingleQuoted(release.version)}`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET=${safeShellSingleQuoted(release.asset)}`,
    `PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256=${safeShellSingleQuoted(release.sha256)}`,
    'bash'
  ].join(' ');
}

export async function createConnectorInstaller(origin: string, userId: string) {
  const publicKey = connectorCommandSigningPublicKey();
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is required to create a per-user connector installer.');
  }
  if (!publicKey) {
    throw new Error(
      'Configure the connector command-signing public key before installing a connector.'
    );
  }
  const release = connectorInstallerReleaseConfig();

  const credential = await createConnectorCredential({
    ttlSeconds: connectorEnrollmentTtlSeconds,
    userId
  });
  const machineId = `connector-${randomUUID()}`;

  return {
    command: connectorInstallCommand(
      origin,
      credential.token,
      publicKey,
      machineId,
      release
    ),
    credentialId: credential.id,
    expiresAt: credential.expiresAt,
    scriptUrl: connectorInstallUrl(origin)
  };
}

export function connectorInstallScript(origin: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

hub_url=${safeShellSingleQuoted(origin)}
registration_token="\${PROJECT_CONNECTOR_ENROLLMENT_CREDENTIAL:-}"
command_public_key_b64="\${PROJECT_CONNECTOR_COMMAND_PUBLIC_KEY_B64:-}"
assigned_machine_id="\${PROJECT_CONNECTOR_ASSIGNED_MACHINE_ID:-}"
bundle_version="\${PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION:-}"
bundle_asset="\${PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:-}"
bundle_sha256="\${PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256:-}"
install_dir="\${PROJECT_SPACE_CONNECTOR_DIR:-$HOME/.local/bin}"
service_name="\${PROJECT_CONNECTOR_SERVICE_NAME:-$(hostname -s)}"
config_dir="\${PROJECT_CONNECTOR_CONFIG_DIR:-$HOME/.config/project-space}"
config_file="\${PROJECT_CONNECTOR_CONFIG:-$config_dir/connector.json}"
credential_file="\${PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE:-$config_dir/connector-credential}"
command_public_key_file="\${PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY_FILE:-$config_dir/command-signing-public-key.pem}"
machine_id_file="\${PROJECT_CONNECTOR_MACHINE_ID_FILE:-$config_dir/machine-id}"

if [ -z "$registration_token" ] || [ -z "$command_public_key_b64" ] || [ -z "$assigned_machine_id" ] || [ -z "$bundle_version" ] || [ -z "$bundle_asset" ] || [ -z "$bundle_sha256" ]; then
  echo "Use the account-specific install command from Project Space settings."
  exit 1
fi

if [ "$(printf '%s' "$bundle_version" | tr '[:upper:]' '[:lower:]')" = "latest" ] ||
   [[ ! "$bundle_version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
   [[ ! "$bundle_asset" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$ ]] ||
   [[ ! "$bundle_sha256" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "The account-specific installer has invalid release metadata. Generate a new command."
  exit 1
fi

download_url="https://github.com/DotNaos/project-space/releases/download/$bundle_version/$bundle_asset"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Project Space currently publishes a packaged connector for macOS arm64."
  echo "For this machine, build from source or install a matching connector binary, then run:"
  echo "project connector setup --prod-url $hub_url"
  echo "PROJECT_CONNECTOR_CONFIG=$config_file PROJECT_CONNECTOR_SERVICE_NAME=$service_name project-space-connector"
  exit 1
fi

mkdir -p "$install_dir"
mkdir -p "$(dirname "$config_file")"
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

tar -xzf "$archive" -C "$tmp_dir"
if [ ! -f "$tmp_dir/project-space-connector" ] || [ ! -f "$tmp_dir/project" ]; then
  echo "Connector bundle must contain project-space-connector and project."
  exit 1
fi
install -m 0755 "$tmp_dir/project-space-connector" "$install_dir/project-space-connector"
install -m 0755 "$tmp_dir/project" "$install_dir/project"

machine_id="$assigned_machine_id"
if [ -f "$machine_id_file" ]; then
  existing_machine_id="$(tr -d '\\r\\n' < "$machine_id_file")"
  if [[ "$existing_machine_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$ ]]; then
    machine_id="$existing_machine_id"
  fi
elif [ -f "$config_file" ]; then
  existing_machine_id="$(sed -n 's/.*"machineId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9._:-]*\\)".*/\\1/p' "$config_file" | head -n 1)"
  if [[ "$existing_machine_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$ ]]; then
    machine_id="$existing_machine_id"
  fi
fi

printf '%s\n' "$registration_token" > "$credential_file"
printf '%s' "$command_public_key_b64" | openssl base64 -d -A > "$command_public_key_file"
printf '%s\n' "$machine_id" > "$machine_id_file"
chmod 600 "$credential_file" "$command_public_key_file" "$machine_id_file"
unset registration_token command_public_key_b64

cat > "$config_file" <<JSON
{
  "machineId": "$machine_id",
  "hubs": [
    {
      "name": "prod",
      "url": "$hub_url",
      "registrationTokenFile": "$credential_file",
      "commandGrantPublicKeyFile": "$command_public_key_file"
    }
  ]
}
JSON

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.os-home.project-space-connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>$install_dir/project-space-connector</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROJECT_CONNECTOR_CONFIG</key>
    <string>$config_file</string>
    <key>PROJECT_CONNECTOR_SERVICE_NAME</key>
    <string>$service_name</string>
    <key>PROJECT_CLI_PATH</key>
    <string>$install_dir/project</string>
    <key>PATH</key>
    <string>$install_dir:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST

launchctl unload "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist" >/dev/null 2>&1 || true
launchctl load "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist"

echo "Project Space connector installed."
echo "Machine service: $service_name"
echo "Hub: $hub_url"
echo "Bundle: $bundle_version/$bundle_asset"
echo "Config: $config_file"
`;
}
