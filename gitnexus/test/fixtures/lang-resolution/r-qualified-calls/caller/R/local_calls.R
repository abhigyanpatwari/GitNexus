# Callers of functions in OTHER local packages, always written with an explicit qualifier.
# Every callee is defined exactly once in the package the qualifier names; the same-name
# definitions in THIS package are decoys the qualifier must never bind to.

# Wrapper self-loop: the wrapper carries the name of the function it forwards to, so the
# scope chain binds the qualified call to the wrapper itself.
tidy <- function(d) {
  locallib::tidy(d)
}

# Same-file decoy: `decoy_fn` is also defined below, in this very file.
decoy_fn <- function(d) d

local_user <- function(d) {
  locallib::decoy_fn(d)
}

# Package whose directory name (renamed_impl) differs from its DESCRIPTION `Package:` (renamed).
compute_it <- function(d) d

renamed_user <- function(d) {
  renamed::compute_it(d)
}

# `:::` reaches an unexported function of the named package.
internal_user <- function(d) {
  locallib:::hidden(d)
}

# Quoted, backticked and spaced qualifiers all name locallib.
quoted_user <- function(d) {
  "locallib"::quoted_fn(d)
}

backticked_user <- function(d) {
  `locallib`::backticked_fn(d)
}

spaced_user <- function(d) {
  locallib ::: spaced_fn(d)
}

# NAMESPACE importFrom(altlib, shared) decoy: the qualifier names locallib.
importfrom_decoy_user <- function(d) {
  locallib::shared(d)
}

# locallib re-exports `reexp_fn` from provlib and defines nothing of that name itself.
reexport_user <- function(d) {
  locallib::reexp_fn(d)
}
