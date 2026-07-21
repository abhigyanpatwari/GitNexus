output "instance_id" {
  description = "EC2 instance id -- needed by register-runner.sh and for manual start/stop."
  value       = aws_instance.evolution_runner.id
}

output "security_group_id" {
  value = aws_security_group.evolution_runner.id
}

output "runner_role_arn" {
  value = aws_iam_role.evolution_runner.arn
}

output "scheduler_role_arn" {
  value = aws_iam_role.evolution_scheduler.arn
}
