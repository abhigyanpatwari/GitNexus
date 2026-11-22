# Package discovery stops at directory depth 3, so the packages under deep/a/b/c/ are never
# found: whether they are local is UNKNOWN, and the qualified sites must be left as they are.

# Same-file decoys for the two qualifiers below.
unk_fn <- function(d) d
filter <- function(d) d

# `invisiblepkg` is a real package (DESCRIPTION `Package:` in deep/a/b/c/impl), invisible to
# discovery, and its directory name does not match: nothing shows it is local.
unknown_user <- function(d) {
  invisiblepkg::unk_fn(d)
}

# With discovery truncated this cannot be shown to be external either.
truncated_external_user <- function(d) {
  dplyr::filter(d)
}

# `pathpkg` has no DESCRIPTION, but its parsed files sit under `pathpkg/R/`.
path_local_user <- function(d) {
  pathpkg::path_fn(d)
}
path_fn <- function(d) d
