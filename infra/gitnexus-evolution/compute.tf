# Base OS + sandbox prerequisites only. The workflow's own steps install
# Node/uv/bubblewrap-adjacent tooling and build the repo fresh every run, so
# user_data only needs the pieces that must exist before the workflow starts
# (bubblewrap, socat, and the unprivileged-userns toggle bubblewrap needs).
locals {
  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail
    apt-get update -y
    apt-get install -y bubblewrap socat
    apparmor_userns=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
    if [ -r "$apparmor_userns" ] && [ "$(cat "$apparmor_userns")" = "1" ]; then
      sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    fi
  EOF
}

resource "aws_instance" "evolution_runner" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default_az.ids[0]
  vpc_security_group_ids      = [aws_security_group.evolution_runner.id]
  iam_instance_profile        = aws_iam_instance_profile.evolution_runner.name
  associate_public_ip_address = true
  user_data                   = local.user_data
  # user_data only runs on first boot (cloud-init); reissuing it on an
  # already-running instance is a no-op, so don't force a replace over it.
  user_data_replace_on_change = false

  root_block_device {
    volume_size           = 100
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name = "gitnexus-evolution-runner"
  }

  lifecycle {
    # Registering with GitHub Actions is a one-time, out-of-band step
    # (register-runner.sh); losing the instance means re-registering by
    # hand, so nothing here should trigger a silent replace. AMI is pinned
    # (see variables.tf) for the same reason.
    prevent_destroy = true
    ignore_changes = [
      # This attribute is unreliable to read back after import (the AWS API
      # doesn't directly expose it; the provider derives it from the primary
      # ENI). The instance genuinely has a public IP already -- don't let a
      # stale read force a destructive replace to "fix" it.
      associate_public_ip_address,
    ]
  }
}
