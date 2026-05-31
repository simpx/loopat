#!/bin/sh
# Inject the test's public key (passed as $AUTHORIZED_KEY) and start sshd.
set -e
echo "$AUTHORIZED_KEY" > /home/git/.ssh/authorized_keys
chown git:git /home/git/.ssh/authorized_keys
chmod 600 /home/git/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
