#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "generate-password-file.sh must run as root" >&2
  exit 1
fi

install -d -m 0755 /opt/platform/core/mqtt/config
password_file=/opt/platform/core/mqtt/config/password_file
if [ -e "$password_file" ]; then
  echo "$password_file already exists; refusing to replace broker credentials" >&2
  exit 1
fi
complete=0
cleanup() {
  if [ "$complete" -ne 1 ]; then
    rm -f "$password_file"
  fi
}
trap cleanup EXIT INT TERM HUP
chown 1883:1883 /opt/platform/core/mqtt/config
chmod 0750 /opt/platform/core/mqtt/config
docker pull eclipse-mosquitto:2.1.2-alpine >/dev/null
docker run --rm -it \
  -v /opt/platform/core/mqtt/config:/mosquitto/config \
  eclipse-mosquitto:2.1.2-alpine \
  mosquitto_passwd -c /mosquitto/config/password_file \
  project-space-jetkvm-b46e1a936ac89a4e
docker run --rm -it \
  -v /opt/platform/core/mqtt/config:/mosquitto/config \
  eclipse-mosquitto:2.1.2-alpine \
  mosquitto_passwd /mosquitto/config/password_file jetkvm-b46e1a936ac89a4e
chown root:1883 /opt/platform/core/mqtt/config/password_file
chmod 0640 /opt/platform/core/mqtt/config/password_file
chown root:root /opt/platform/core/mqtt/config
chmod 0755 /opt/platform/core/mqtt/config
complete=1
