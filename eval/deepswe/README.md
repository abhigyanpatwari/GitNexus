# DeepSWE: baseline vs GitNexus CLI

[DeepSWE](https://deepswe.datacurve.ai/) has 113 long-horizon tasks across 91 repositories in five languages. The tasks were written from scratch, and the solutions need about 5.5x more code than SWE-bench Pro. This directory runs a paired comparison on a sampled subset with the benchmark's own harness, [pier](https://github.com/datacurve-ai/pier):

| Arm | What the agent gets |
| --- | --- |
| `baseline` | The DeepSWE task, unchanged |
| `gitnexus` | The same task, plus the `gitnexus` CLI and an index of `/app` built into the image, and a short note on the CLI appended to the instruction |

The default agent is `mini-swe-agent`, which the leaderboard uses. It is bash-only, so GitNexus is reached through the real CLI (`gitnexus query`, `context`, `impact`, `detect-changes`) rather than MCP. The arms differ only in that layer and that note.

The workflow_bench `baseline_cli` arm points the same way: on the small release tasks, a shell command cost far less than the MCP tool catalog.

## How the GitNexus arm is built

Task agents run with no network (`allow_internet = false`; pier allowlists only the model API). Nothing can be installed at run time, so `prepare.py` gives each `gitnexus` task a derived Dockerfile:

1. `FROM` the task's prebuilt image.
2. Node from the official tarball, checked against `SHASUMS256.txt`.
3. `npm install -g` of a `gitnexus` tarball built from this checkout.
4. `gitnexus analyze --index-only`. This writes no AGENTS.md, CLAUDE.md or skills, and `.gitnexus/` is git-excluded. The build fails if `git status` changed, because that would leak into the graded patch.

The task is renamed `<name>-gitnexus`, so pier's per-task image tag never reuses a baseline image. The verifier, its separate image, the patch collector and the timeouts are untouched; only the build timeout is raised to fit indexing. `report.py` strips the suffix and pairs trials by task id.

## Run it on EC2

Use a dedicated instance, not the self-hosted release-evaluation runner. It needs an authenticated AWS CLI (`aws login`).

```bash
eval/deepswe/ec2/launch.sh --ref main            # add --dry-run to print the plan only
ssh -i ~/.ssh/gitnexus-deepswe.pem ubuntu@<ip>   # wait for ~/BOOTSTRAP_DONE
export OPENAI_API_KEY=...                        # in the session, never in user-data
cd ~/GitNexus && eval/deepswe/run.sh --n-tasks 10 --concurrency 4
```

`launch.sh` does the following:

- Starts Ubuntu 24.04 on an `m7i.4xlarge` (16 vCPU / 64 GiB) with a 400 GB gp3 volume.
- Tags the instance `purpose=gitnexus-deepswe`.
- Opens SSH to your current IP only.
- Stops the instance after `--max-hours` (default 12).

It prints the `scp` and `terminate-instances` commands for when you're done.

`run.sh` performs these steps:

1. Pins `deep-swe` to a commit.
2. Builds the gitnexus package (the same steps as the CI package job).
3. Prepares both arms on one seeded subset.
4. Runs `pier run` per arm.
5. Writes `deepswe-comparison.{md,json}`.

The main options are listed below; `run.sh --help` shows them all.

| Option | Default | Notes |
| --- | --- | --- |
| `--n-tasks`, `--seed`, `--task` | 10, 0 | `--task` (repeatable) overrides the sample; `--n-tasks 0` runs all 113 |
| `--agent`, `--model`, `--effort` | `mini-swe-agent`, `openai/gpt-5.6-sol`, `low` | `--agent claude-code` also works with `ANTHROPIC_API_KEY` |
| `--cost-limit` | `5` | Per-trial agent cost cap in USD, the same for both arms. A capped trial ends unsolved. |
| `--concurrency` | `2` | Trials per arm at once. Each needs 2 CPUs and 8 GB. |
| `--package` | build from checkout | Pass a prebuilt `npm pack` tarball to skip the build |

## Reading the report

`report.py` pairs the two pier jobs by task id and attempt:

- Deltas use only pairs graded in both arms with the metric measured in both.
- Ungraded trials, interrupted sweeps and missing cost are listed under **Problems**. A grader crash writes reward `-1`, which counts as ungraded.
- `GitNexus usage` counts `gitnexus <command>` calls at command position in the ATIF trajectories.

```bash
python3 -m deepswe.report --baseline <jobs>/baseline-<stamp> --gitnexus <jobs>/gitnexus-<stamp> --out <dir>
```

A sampled subset gives descriptive evidence, not statistical significance. DeepSWE trials can run for up to 3 hours each, and leaderboard costs run from about $2 to $12 per task at high effort, so start with a small `--n-tasks` and a cost cap.
