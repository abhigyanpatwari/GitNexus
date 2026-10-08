# Qualified calls to packages that are not part of the repository (certainly external).
# Each name collides with a local definition that the qualifier rules out.

# Same-file decoy.
filter <- function(d) d

external_same_file_user <- function(d) {
  dplyr::filter(d)
}

# The colliding definition lives in another local package (provlib), not in this file.
external_other_pkg_user <- function(d) {
  dplyr::mutate(d)
}

# `:::` to an external package.
internal_helper <- function(d) d

external_internal_user <- function(d) {
  dplyr:::internal_helper(d)
}
