# Matches the workflow's own cron (`0 3 * * 6`, Saturday 03:00 UTC): start
# 15 minutes early so the runner is online and idle before GitHub dispatches
# the job, and stop 24h later as a safety net that lines up with the
# workflow's own `timeout-minutes: 1440` ceiling -- so it can never cut off
# a run that's still legitimately within its own allowed window. Manual
# workflow_dispatch runs still need the instance started by hand first (or
# via register-runner.sh's start helper).

resource "aws_scheduler_schedule" "start" {
  name        = "gitnexus-evolution-start"
  description = "Start the gitnexus-evolution runner 15min before the workflow's Saturday 03:00 UTC cron"

  schedule_expression          = "cron(45 2 ? * SAT *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.evolution_scheduler.arn
    input    = jsonencode({ InstanceIds = [aws_instance.evolution_runner.id] })
  }
}

resource "aws_scheduler_schedule" "stop" {
  name        = "gitnexus-evolution-stop"
  description = "Safety-net stop 24h after start, matching the workflow's own 1440min timeout ceiling"

  schedule_expression          = "cron(0 3 ? * SUN *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.evolution_scheduler.arn
    input    = jsonencode({ InstanceIds = [aws_instance.evolution_runner.id] })
  }
}
