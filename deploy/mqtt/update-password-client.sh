#!/usr/bin/env sh
set -eu

username=${1:-}
if [ "${#username}" -gt 128 ]; then
  echo "usage: update-password-client.sh <project-space-jetkvm-*|jetkvm-*>" >&2
  exit 64
fi
case "$username" in
  *[!A-Za-z0-9._-]*|'')
    echo "usage: update-password-client.sh <project-space-jetkvm-*|jetkvm-*>" >&2
    exit 64
    ;;
esac
case "$username" in
  project-space-jetkvm-?*|jetkvm-?*) ;;
  *)
    echo "usage: update-password-client.sh <project-space-jetkvm-*|jetkvm-*>" >&2
    exit 64
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "update-password-client.sh must run as root" >&2
  exit 1
fi

config_root=/opt/platform/core/mqtt/config
password_file=$config_root/password_file
lock_file=$config_root/password-file.lock
new_password_file=$config_root/password_file.new.$$
exec 9>"$lock_file"
flock -x 9
if [ ! -s "$password_file" ]; then
  echo "missing $password_file" >&2
  exit 1
fi

work_root=$(mktemp -d /opt/platform/core/mqtt/password-update.XXXXXX)
complete=0
cleanup() {
  if [ -n "$work_root" ] && [ -d "$work_root" ]; then
    rm -rf "$work_root"
  fi
  if [ "$complete" -ne 1 ]; then
    rm -f "$new_password_file"
  fi
}
trap cleanup EXIT INT TERM HUP

install -m 0600 "$password_file" "$work_root/password_file"
docker pull eclipse-mosquitto:2.1.2-alpine >/dev/null
docker run --rm -it --user 0:0 \
  -v "$work_root:/mosquitto/config" \
  eclipse-mosquitto:2.1.2-alpine \
  mosquitto_passwd /mosquitto/config/password_file "$username"

install -m 0640 "$work_root/password_file" "$new_password_file"
chown root:1883 "$new_password_file"
mv "$new_password_file" "$password_file"
docker kill --signal HUP private-platform-mqtt >/dev/null
complete=1
echo "updated MQTT client: $username"
