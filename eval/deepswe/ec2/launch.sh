#!/usr/bin/env bash
# Launch a dedicated EC2 instance for DeepSWE runs (separate from the
# self-hosted release-evaluation runner). Prints the SSH and cleanup commands.
#
#   eval/deepswe/ec2/launch.sh --ref main --instance-type m7i.4xlarge
#
# Needs an authenticated AWS CLI. Creates, if missing, an SSH key pair
# (private key saved under ~/.ssh) and a security group open on port 22 to
# your current public IP only. The instance stops itself after --max-hours.
set -euo pipefail

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
REGION="${REGION:-us-east-1}"
INSTANCE_TYPE=m7i.4xlarge  # 16 vCPU / 64 GiB: room for 4 concurrent 2-CPU / 8 GB trials plus builds
VOLUME_GB=400              # task images are several GB each; derived images add the index
MAX_HOURS=12
KEY_NAME=gitnexus-deepswe
SG_NAME=gitnexus-deepswe-ssh
NAME="gitnexus-deepswe-$(date -u +%Y%m%d-%H%M)"
GITNEXUS_REPO=https://github.com/abhigyanpatwari/GitNexus.git
GITNEXUS_REF=main
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --volume-gb) VOLUME_GB="$2"; shift 2 ;;
    --max-hours) MAX_HOURS="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --repo) GITNEXUS_REPO="$2"; shift 2 ;;
    --ref) GITNEXUS_REF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
user_data="$(mktemp)"
trap 'rm -f "$user_data"' EXIT
sed -e "s|@GITNEXUS_REPO@|$GITNEXUS_REPO|" -e "s|@GITNEXUS_REF@|$GITNEXUS_REF|" -e "s|@MAX_HOURS@|$MAX_HOURS|" \
  "$HERE/bootstrap.sh" > "$user_data"
if grep -q '@[A-Z_]*@' "$user_data"; then echo "unfilled bootstrap placeholder" >&2; exit 1; fi

aws_() { aws --region "$REGION" "$@"; }
identity="$(aws_ sts get-caller-identity --query Arn --output text)"
ami="$(aws_ ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)"
echo "account identity: $identity"
echo "region=$REGION ami=$ami type=$INSTANCE_TYPE volume=${VOLUME_GB}GB max-hours=$MAX_HOURS ref=$GITNEXUS_REF"
if [ "$DRY_RUN" = 1 ]; then
  echo "--dry-run: nothing created"; exit 0
fi

if ! aws_ ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  mkdir -p "$HOME/.ssh"
  aws_ ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial --output text > "$HOME/.ssh/$KEY_NAME.pem"
  chmod 600 "$HOME/.ssh/$KEY_NAME.pem"
  echo "created key pair $KEY_NAME -> ~/.ssh/$KEY_NAME.pem"
fi

vpc="$(aws_ ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
[ "$vpc" != None ] || { echo "no default VPC in $REGION" >&2; exit 1; }
sg="$(aws_ ec2 describe-security-groups --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$vpc" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$sg" = None ]; then
  sg="$(aws_ ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$vpc" \
    --description "SSH to GitNexus DeepSWE runners" --query GroupId --output text)"
fi
my_ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
aws_ ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$my_ip/32" \
  >/dev/null 2>&1 || true  # already allowed

instance="$(aws_ ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
  --security-group-ids "$sg" --user-data "file://$user_data" \
  --instance-initiated-shutdown-behavior stop \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=purpose,Value=gitnexus-deepswe}]" \
  --query 'Instances[0].InstanceId' --output text)"
aws_ ec2 wait instance-running --instance-ids "$instance"
ip="$(aws_ ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)"

cat <<EOF
instance: $instance ($NAME) in $REGION, public IP $ip
bootstrap takes a few minutes; it is done when ~/BOOTSTRAP_DONE exists.

  ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@$ip
  # on the instance:
  export OPENAI_API_KEY=...   # never put it in user-data
  tmux new -s deepswe 'cd ~/GitNexus && eval/deepswe/run.sh --n-tasks 10 --concurrency 4 2>&1 | tee ~/deepswe-run.log'
  # results:
  scp -i ~/.ssh/$KEY_NAME.pem -r ubuntu@$ip:deepswe-work/report-\* .
  # when finished (deletes the instance and its volume):
  aws --region $REGION ec2 terminate-instances --instance-ids $instance
EOF
