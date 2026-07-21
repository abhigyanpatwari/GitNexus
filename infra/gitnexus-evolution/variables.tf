variable "aws_region" {
  description = "AWS region for the runner instance and its supporting resources."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for the runner. 2vCPU/8GB is enough headroom above this repo's documented buffer-pool ceiling for the current serial (one-session-at-a-time) benchmark loop."
  type        = string
  default     = "m6i.large"
}

variable "ami_id" {
  description = <<-EOT
    Pinned Ubuntu 24.04 AMI id. Deliberately pinned rather than resolved live
    from the SSM "current" parameter: tracking "current" would make a routine
    `terraform plan` want to replace the runner instance (and lose its GitHub
    Actions registration) the moment Canonical ships a new point release.
    Rotate deliberately by looking up a fresh id:
      aws ssm get-parameters \
        --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
        --query 'Parameters[0].Value' --output text --region us-east-1
    and re-run infra/gitnexus-evolution/register-runner.sh afterward.
  EOT
  type        = string
  default     = "ami-052355af2a014bd2c"
}

variable "runner_label" {
  description = "Custom label the workflow's runs-on targets (alongside the auto-applied self-hosted/linux/x64 labels)."
  type        = string
  default     = "gitnexus-evolution"
}

variable "github_owner" {
  description = "GitHub org/user that owns the repository."
  type        = string
  default     = "abhigyanpatwari"
}

variable "github_repo" {
  description = "Repository name (not owner/repo -- the provider's owner argument carries the owner)."
  type        = string
  default     = "GitNexus"
}
