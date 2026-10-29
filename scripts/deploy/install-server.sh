#!/usr/bin/env bash
# One-time setup on the existing server-sh host, run as root. Does not restart services.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run as root'; exit 1; }
id deploy >/dev/null
systemctl cat acerciae.service acerciae-pdf.service >/dev/null
test -x /usr/sbin/iptables
test -x /usr/bin/pg_dump

# The old ExecStartPre ran a root script under writable /srv with backend.env.
# Give the firewall its own root-owned unit without that writable environment,
# before granting deploy permission to start the application services.
install -d -m 755 /usr/local/libexec /etc/systemd/system/acerciae.service.d
cat > /usr/local/libexec/acerciae-restrict-backend <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/iptables -C INPUT ! -i lo -p tcp --dport 18083 -j REJECT 2>/dev/null || /usr/sbin/iptables -I INPUT ! -i lo -p tcp --dport 18083 -j REJECT
EOF
chown root:root /usr/local/libexec/acerciae-restrict-backend
chmod 755 /usr/local/libexec/acerciae-restrict-backend
cat > /etc/systemd/system/acerciae-firewall.service <<'EOF'
[Unit]
Description=Restrict Acerciae backend to local reverse proxy
Before=acerciae.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/acerciae-restrict-backend
RemainAfterExit=yes
EOF
cat > /etc/systemd/system/acerciae.service.d/deployment.conf <<'EOF'
[Unit]
Requires=acerciae-firewall.service
After=acerciae-firewall.service

[Service]
ExecStartPre=
EOF
chown root:root /etc/systemd/system/acerciae-firewall.service /etc/systemd/system/acerciae.service.d/deployment.conf
chmod 644 /etc/systemd/system/acerciae-firewall.service /etc/systemd/system/acerciae.service.d/deployment.conf
systemd-analyze verify acerciae-firewall.service acerciae.service acerciae-pdf.service
systemctl daemon-reload

temporary="$(mktemp)"
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl stop acerciae-pdf.service acerciae.service, /usr/bin/systemctl start acerciae.service acerciae-pdf.service
deploy ALL=(postgres) NOPASSWD: /usr/bin/pg_dump --format=custom acerciae
EOF
visudo -cf "$temporary"
install -o root -g root -m 440 "$temporary" /etc/sudoers.d/acerciae-deploy
visudo -c
echo 'Deployment permissions installed. Running application services were not restarted.'
