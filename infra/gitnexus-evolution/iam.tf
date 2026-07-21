# --- Runner instance role: lets the box be managed over SSM Session Manager
# (no SSH keypair, no open inbound port) -------------------------------------

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "evolution_runner" {
  name               = "gitnexus-evolution-runner"
  description        = "GitNexus skill-evolution self-hosted Actions runner (SSM-managed, no SSH)"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_role_policy_attachment" "evolution_runner_ssm" {
  role       = aws_iam_role.evolution_runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "evolution_runner" {
  name = "gitnexus-evolution-runner"
  role = aws_iam_role.evolution_runner.name
}

# --- Scheduler role: starts/stops exactly this one instance, nothing else ---

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "evolution_scheduler" {
  name               = "gitnexus-evolution-scheduler"
  description        = "Starts/stops the gitnexus-evolution runner around its weekly cron"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "scheduler_start_stop" {
  statement {
    effect    = "Allow"
    actions   = ["ec2:StartInstances", "ec2:StopInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.evolution_runner.id}"]
  }
}

resource "aws_iam_role_policy" "evolution_scheduler_start_stop" {
  name   = "start-stop-runner-instance"
  role   = aws_iam_role.evolution_scheduler.id
  policy = data.aws_iam_policy_document.scheduler_start_stop.json
}
