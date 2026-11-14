# DeepSWE: baseline vs GitNexus CLI

[DeepSWE](https://deepswe.datacurve.ai/) has 113 long-horizon tasks across 91 repositories in five languages. The tasks were written from scratch, and the solutions need about 5.5x more code than SWE-bench Pro. This directory runs a paired comparison on a sampled subset with the benchmark's own harness, [pier](https://github.com/datacurve-ai/pier):

| Arm | What the agent gets |
| --- | --- |
| `baseline` | The DeepSWE task, unchanged |
| `gitnexus` | The same task, plus the `gitnexus` CLI and an index of `/app` built into the image, and a short note on the CLI appended to the instruction |

The default agent is Claude Code (pier's `claude-code`, pinned to the release evaluation's CLI). GitNexus is reached through the real CLI (`gitnexus query`, `context`, `impact`, `detect-changes`) rather than MCP. The arms differ only in that layer and that note.

- **Toolset.** Claude Code gets only `Read`, `Edit`, `Write` and `Bash`, matching the release evaluation's single-agent toolset. Subagents, background tasks, skills and web tools are disallowed, and pier's forced background-task env is switched off. Without this, one smoke trial ran 237 background agents past its budget cap.
- **Guidance.** The note (`--guidance product`, the default) is the CLI form of the rules GitNexus ships in AGENTS.md: graph first, `impact` before editing a symbol, `detect-changes` before committing. In the release evaluation, arms load those directives the same way. `--guidance optional` only lists the commands; in a smoke trial the agent then never used them.

The workflow_bench `baseline_cli` arm points the same way: on the small release tasks, a shell command cost far less than the MCP tool catalog. `--agent mini-swe-agent`, the leaderboard's agent, also works.

### Model access

- **Non-Claude models** (default `gpt-5.6-sol`, `OPENAI_API_KEY`): `run.sh` starts a LiteLLM gateway container. It is routed like `workflow_bench.model_gateway`, with Claude Code's Anthropic Messages served from OpenAI's Responses API, a random master key, and the LiteLLM version from `eval/uv.lock`.
  - It listens on host port 80, because pier's egress proxy only allows ports 80 and 443. Keep that port closed to the outside; `launch.sh`'s security group only opens SSH.
  - Trials reach it as `host.docker.internal` on Docker Desktop, or as the EC2 private DNS name.
- **Claude models** (`--model anthropic/<model>`): use `ANTHROPIC_API_KEY` directly.

Costs come from Claude Code's own per-session accounting (`total_cost_usd`). Through the gateway that is Claude Code's price table applied to a non-Claude model, so it is consistent across arms but is not the provider's invoice.

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

Task images are about 4 GB each, plus pier's agent layer and the GitNexus layer, so 400 GB fits roughly 40–50 tasks across both arms. For all 113 tasks, pass `--volume-gb 1000` or run `docker image prune -a` between batches.

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
| `--agent`, `--model`, `--effort` | `claude-code`, `gpt-5.6-sol`, `low` | `--model anthropic/<model>` skips the gateway. `--agent mini-swe-agent` takes litellm names such as `openai/gpt-5.6-sol`. |
| `--cost-limit` | `5` | Per-trial agent cost cap in USD, the same for both arms. A capped trial ends unsolved. |
| `--concurrency` | `2` | Trials per arm at once. Each needs 2 CPUs and 8 GB. |
| `--package` | build from checkout | Pass a prebuilt `npm pack` tarball to skip the build |

## Reading the report

`report.py` pairs the two pier jobs by task id and attempt:

- Deltas use only pairs graded in both arms with the metric measured in both.
- Ungraded trials, interrupted sweeps and missing cost are listed under **Problems**. A grader crash writes reward `-1`, which counts as ungraded.
- A trial whose agent hit `--cost-limit` or exited nonzero still had its patch graded. It counts as an unresolved attempt, listed as an agent error, not dropped.
- `GitNexus usage` counts `gitnexus <command>` calls at command position in the ATIF trajectories.

```bash
python3 -m deepswe.report --baseline <jobs>/baseline-<stamp> --gitnexus <jobs>/gitnexus-<stamp> --out <dir>
```

A sampled subset gives descriptive evidence, not statistical significance. DeepSWE trials can run for up to 3 hours each, and leaderboard costs run from about $2 to $12 per task at high effort, so start with a small `--n-tasks` and a cost cap.
