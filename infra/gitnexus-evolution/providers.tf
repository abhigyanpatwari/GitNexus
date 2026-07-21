# AWS credentials: standard credential chain (AWS_PROFILE / AWS_ACCESS_KEY_ID
# etc. in the environment). Never hardcode a profile name here -- it's
# account-specific and this config is meant to be reusable.
provider "aws" {
  region = var.aws_region
}

# GitHub token: reads GITHUB_TOKEN from the environment automatically
# (e.g. `export GITHUB_TOKEN=$(gh auth token)`). Needs admin rights on the
# repository to manage environments and deployment branch policies.
provider "github" {
  owner = var.github_owner
}

data "aws_caller_identity" "current" {}
