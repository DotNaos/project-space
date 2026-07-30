#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-on-vps.sh must run as root" >&2
  exit 1
fi

source_dir=${1:-}
if [ -z "$source_dir" ] || [ ! -f "$source_dir/compose.yml" ]; then
  echo "usage: install-on-vps.sh <staged-mqtt-directory>" >&2
  exit 1
fi

mqtt_root=/opt/platform/core/mqtt
state_root=/opt/platform/state/mqtt

docker network inspect traefik-public >/dev/null

install -d -m 0755 "$mqtt_root/config"
install -d -m 0755 "$state_root/data"
chown 1883:1883 "$state_root/data"
install -m 0644 "$source_dir/compose.yml" "$mqtt_root/compose.yml"
install -m 0644 "$source_dir/config/mosquitto.conf" "$mqtt_root/config/mosquitto.conf"
install -m 0644 "$source_dir/config/acl" "$mqtt_root/config/acl"

if [ ! -s "$mqtt_root/config/password_file" ]; then
  echo "missing $mqtt_root/config/password_file" >&2
  exit 1
fi
chown root:1883 "$mqtt_root/config/password_file"
chmod 0640 "$mqtt_root/config/password_file"

docker compose -f "$mqtt_root/compose.yml" config >/dev/null
docker compose -f "$mqtt_root/compose.yml" up -d
docker kill --signal HUP private-platform-mqtt >/dev/null
