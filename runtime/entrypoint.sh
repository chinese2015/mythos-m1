#!/bin/sh
set -eu
umask 0002
mkdir -p /run/sshd
cp /etc/mythos/authorized_keys /run/mythos-authorized_keys
chmod 644 /run/mythos-authorized_keys
ssh-keygen -q -t ed25519 -N '' -f /run/ssh_host_ed25519_key
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
