#!/usr/bin/env bash
# EC2 user-data for a DeepSWE runner (Ubuntu 24.04). launch.sh fills in the
# @...@ values. No model key is passed here: user-data is readable from the
# instance metadata service, so export the key in your SSH session instead.
set -euxo pipefail

GITNEXUS_REPO='@GITNEXUS_REPO@'
GITNEXUS_REF='@GITNEXUS_REF@'
MAX_HOURS='@MAX_HOURS@'
NODE_VERSION=22.18.0
PIER_VERSION=0.3.1
USER_NAME=ubuntu
HOME_DIR=/home/$USER_NAME

# Cost guard: stop (not terminate, so results survive) after MAX_HOURS.
shutdown -h "+$((MAX_HOURS * 60))" "DeepSWE runner max lifetime reached"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends docker.io docker-compose-v2 git python3 curl ca-certificates jq tmux
systemctl enable --now docker
usermod -aG docker "$USER_NAME"

case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
tarball="node-v${NODE_VERSION}-linux-${arch}.tar.gz"
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}$" | sha256sum -c -
tar -xzf "$tarball" -C /usr/local --strip-components=1
rm "$tarball"

sudo -iu "$USER_NAME" bash -lc "curl -LsSf https://astral.sh/uv/install.sh | sh"
sudo -iu "$USER_NAME" bash -lc "\$HOME/.local/bin/uv tool install datacurve-pier==${PIER_VERSION}"
sudo -iu "$USER_NAME" git clone --quiet "$GITNEXUS_REPO" "$HOME_DIR/GitNexus"
sudo -iu "$USER_NAME" git -C "$HOME_DIR/GitNexus" fetch --quiet origin "$GITNEXUS_REF"
sudo -iu "$USER_NAME" git -C "$HOME_DIR/GitNexus" checkout --quiet --detach FETCH_HEAD

echo "ready $(date -u +%FT%TZ) gitnexus=$(sudo -iu "$USER_NAME" git -C "$HOME_DIR/GitNexus" rev-parse HEAD)" \
  > "$HOME_DIR/BOOTSTRAP_DONE"
chown "$USER_NAME:$USER_NAME" "$HOME_DIR/BOOTSTRAP_DONE"
