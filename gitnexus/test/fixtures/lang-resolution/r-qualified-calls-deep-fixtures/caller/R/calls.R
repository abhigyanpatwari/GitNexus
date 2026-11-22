# The package's tests/testthat/fixtures/ directory sits below the depth-3 discovery limit
# (repo/caller/tests/testthat/fixtures) but holds no package, so discovery is complete:
# `dplyr` is certainly external and the qualified call must not bind to the local decoy.

# Same-file decoy for the external qualifier below.
filter <- function(d) d

external_user <- function(d) {
  dplyr::filter(d)
}

# A qualifier naming this (discovered) package still binds precisely (own_fn is in util.R).
own_user <- function(d) {
  deepcaller::own_fn(d)
}
