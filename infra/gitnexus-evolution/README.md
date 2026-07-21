# gitnexus-evolution infra

Terraform for the self-hosted runner and GitHub-side wiring that
`.github/workflows/gitnexus-skill-evolution.yml` needs. See that workflow's
own header comment for the full activation checklist -- this only covers the
pieces that are actually codified here.

## What this manages

- **AWS**: an on-demand EC2 instance (stopped by default) registered as the
  workflow's self-hosted runner, an outbound-only security group, an IAM
  role/instance profile for SSM Session Manager access (no SSH), and two
  EventBridge Scheduler schedules that start the instance ~15 minutes before
  the workflow's Saturday 03:00 UTC cron and stop it 24 hours later as a
  safety net.
- **GitHub**: the protected `gitnexus-evolution` environment and its
  deployment branch policy (restricted to `main`).

## What this deliberately does NOT manage

- **Secret values.** `GITNEXUS_BENCH_AUTH_TOKEN`, `RELEASE_APP_ID`, and
  `RELEASE_APP_PRIVATE_KEY` stay a manual, one-time step (see the workflow's
  activation checklist) so a real API key or private key never lands in
  Terraform state.
- **Runner registration.** A GitHub Actions runner registration token is
  single-use and expires in about an hour -- there's nothing durable for
  Terraform to manage. Run `register-runner.sh` once after `apply`, and
  again any time the instance is replaced.

## Prerequisites

```sh
export AWS_PROFILE=<a profile with EC2/IAM/Scheduler permissions>
export GITHUB_TOKEN=$(gh auth token)   # needs admin rights on the repo
```

## First-time setup

```sh
terraform init
terraform plan
terraform apply
./register-runner.sh
```

Then follow the remaining steps in the workflow's own activation checklist
(secrets, a validation `workflow_dispatch` run, and finally setting the
`GITNEXUS_EVOLUTION_ENABLED` repository variable to `true`).

## Adopting already-existing resources

If these resources were created by hand before this config existed (as they
were the first time), import them once so Terraform manages them going
forward instead of trying to create duplicates:

```sh
terraform import aws_iam_role.evolution_runner gitnexus-evolution-runner
terraform import aws_iam_role_policy_attachment.evolution_runner_ssm \
  gitnexus-evolution-runner/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
terraform import aws_iam_instance_profile.evolution_runner gitnexus-evolution-runner
terraform import aws_security_group.evolution_runner <sg-id>
terraform import aws_instance.evolution_runner <instance-id>
terraform import aws_iam_role.evolution_scheduler gitnexus-evolution-scheduler
terraform import aws_iam_role_policy.evolution_scheduler_start_stop \
  gitnexus-evolution-scheduler:start-stop-runner-instance
terraform import aws_scheduler_schedule.start default/gitnexus-evolution-start
terraform import aws_scheduler_schedule.stop default/gitnexus-evolution-stop
terraform import github_repository_environment.evolution GitNexus:gitnexus-evolution
terraform import github_repository_environment_deployment_policy.evolution_main \
  GitNexus:gitnexus-evolution:<deployment-policy-id>
```

Run `terraform plan` after importing -- it should report no changes. If it
proposes any, the config doesn't yet match reality; fix the config rather
than letting `apply` change live infrastructure to match a guess.

## Cost

Stopped (the default state): ~$8/month for the 100GB gp3 volume, $0 compute.
Running (`m6i.large`, on-demand, us-east-1): ~$0.096/hour. A full-day
benchmark run costs well under $3 in compute.
