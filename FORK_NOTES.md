# GitNexus Agentic Fork Notes

This repository is being maintained as an independent noncommercial fork of
GitNexus. The permanent fork project name is **NexusForge**.

During the development period the CLI and npm package continue to use
`gitnexus` for compatibility. A future package/command migration should include
aliases, deprecation copy, and release notes before changing the executable
name.

## Relationship To Upstream

- Upstream project: https://github.com/abhigyanpatwari/GitNexus
- This fork is not affiliated with, endorsed by, or maintained by the upstream
  GitNexus maintainers.
- The upstream license and attribution must remain intact.
- Upstream bug fixes may be pulled in when they help this fork, but upstream
  mergeability is not the primary design constraint.

## License Boundary

The upstream project is licensed under the PolyForm Noncommercial License
1.0.0. This fork inherits that licensing posture unless and until the project
receives a different license grant from the original licensor.

Practical implications:

- Noncommercial research, experimentation, personal use, and public-learning
  work are the expected use cases.
- Commercial use, commercial redistribution, hosted services, or product use
  need legal review and likely separate permission from the upstream licensor.
- Keep `LICENSE` with any distribution of this fork.
- Keep visible attribution to the upstream GitNexus project.

## Fork Product Direction

The fork is optimized for agentic coding workflows rather than for small
upstream PRs. The focus is to turn GitNexus from a strong static code graph into
a live agent operations layer:

- Real-time incremental indexing and file-watch updates.
- Cross-repository contract awareness as a first-class workflow.
- Runtime and log signal overlays on top of the static graph.
- Agent safety tools such as impact scoring and context export.
- Human-guided 3D graph workflows for selecting, clipping, and debugging agent
  context.
- Portable context snapshots for team sharing.

## Near-Term Fork Hygiene

Before large feature work, keep the fork easy to reason about:

- Add fork-specific roadmap and documentation.
- Preserve upstream docs that are still accurate.
- Mark upstream commercial, badge, and release-signing language where it refers
  to upstream infrastructure.
- Defer package/CLI renames until there is a permanent name and a migration
  plan.
