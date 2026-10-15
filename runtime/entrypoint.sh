#!/bin/sh
set -eu
mkdir -p /run/sshd
ssh-keygen -q -t ed25519 -N '' -f /run/ssh_host_ed25519_key
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
