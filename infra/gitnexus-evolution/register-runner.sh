#!/bin/bash
# Registers (or re-registers) the GitHub Actions self-hosted runner on the
# instance this Terraform config creates.
#
# Why this isn't in Terraform: a runner registration token is single-use and
# expires in about an hour, so there's nothing durable for Terraform to
# manage -- baking a token into `user_data` would go stale between `plan`
# and `apply`, or on any future instance replacement. Run this once after
# `terraform apply` creates the instance, and again any time the instance is
# replaced or the runner needs to be re-registered.
#
# Requires: gh (authenticated with admin rights on the repo), aws cli
# (credentials for the account the instance lives in), terraform (to read
# outputs).
set -euo pipefail

REPO="${GITHUB_REPO:-abhigyanpatwari/GitNexus}"
RUNNER_LABEL="${RUNNER_LABEL:-gitnexus-evolution}"
RUNNER_NAME="${RUNNER_NAME:-aws-gitnexus-evolution-1}"

cd "$(dirname "$0")"
INSTANCE_ID="$(terraform output -raw instance_id)"
echo "Instance: ${INSTANCE_ID}"

echo "Starting instance (registration needs it running)..."
aws ec2 start-instances --instance-ids "${INSTANCE_ID}" >/dev/null
aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}"

echo "Waiting for SSM agent..."
for _ in $(seq 1 20); do
  status="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "${status}" = "Online" ] && break
  sleep 10
done
if [ "${status:-}" != "Online" ]; then
  echo "SSM never came online -- aborting." >&2
  exit 1
fi

echo "Minting a fresh runner registration token..."
TOKEN="$(gh api --method POST "repos/${REPO}/actions/runners/registration-token" --jq '.token')"

SCRATCH="$(mktemp -d)"
PARAMS_JSON="$(mktemp)"
trap 'rm -rf "${SCRATCH}" "${PARAMS_JSON}"' EXIT

cat >"${SCRATCH}/install-runner.sh" <<EOF
#!/bin/bash
set -euo pipefail
sudo -u ubuntu -H bash -c 'mkdir -p ~/actions-runner'
RUNNER_VERSION=\$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/^v//')
echo "runner_version=\${RUNNER_VERSION}"
sudo -u ubuntu -H bash -c "cd ~/actions-runner && curl -sL -o runner.tar.gz https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz && tar xzf runner.tar.gz"
cd /home/ubuntu/actions-runner
./bin/installdependencies.sh
sudo -u ubuntu -H bash -c "cd ~/actions-runner && ./config.sh --url https://github.com/${REPO} --token ${TOKEN} --labels ${RUNNER_LABEL} --name ${RUNNER_NAME} --unattended --replace"
./svc.sh install ubuntu
./svc.sh start
EOF

B64="$(base64 -w0 "${SCRATCH}/install-runner.sh")"
python3 -c "
import json, sys
print(json.dumps({'commands': [f'echo {sys.argv[1]} | base64 -d > /tmp/install-runner.sh', 'bash /tmp/install-runner.sh']}))
" "${B64}" >"${PARAMS_JSON}"

echo "Installing and starting the runner via SSM..."
CMD_ID="$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "register gitnexus-evolution runner" \
  --parameters "file://${PARAMS_JSON}" \
  --query 'Command.CommandId' --output text)"

for _ in $(seq 1 24); do
  cmd_status="$(aws ssm get-command-invocation --command-id "${CMD_ID}" --instance-id "${INSTANCE_ID}" --query 'Status' --output text)"
  [ "${cmd_status}" != "InProgress" ] && [ "${cmd_status}" != "Pending" ] && break
  sleep 10
done
if [ "${cmd_status}" != "Success" ]; then
  echo "Install command finished with status ${cmd_status}:" >&2
  aws ssm get-command-invocation --command-id "${CMD_ID}" --instance-id "${INSTANCE_ID}" --query 'StandardErrorContent' --output text >&2
  exit 1
fi

echo "Verifying runner registration..."
gh api "repos/${REPO}/actions/runners" --jq ".runners[] | select(.name==\"${RUNNER_NAME}\")"

echo "Done. Stop the instance now if you don't need it running immediately:"
echo "  aws ec2 stop-instances --instance-ids ${INSTANCE_ID}"
