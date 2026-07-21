data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_az" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Outbound-only: the runner only ever needs to reach github.com and the
# model API, and is managed via SSM Session Manager (no SSH, no inbound
# port at all).
resource "aws_security_group" "evolution_runner" {
  name        = "gitnexus-evolution-runner"
  description = "GitNexus skill-evolution runner: outbound-only, no inbound (SSM access, no SSH)"
  vpc_id      = data.aws_vpc.default.id

  # All outbound (matches the security group's AWS-default egress rule set at
  # creation time; no description field so import shows zero drift).
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
