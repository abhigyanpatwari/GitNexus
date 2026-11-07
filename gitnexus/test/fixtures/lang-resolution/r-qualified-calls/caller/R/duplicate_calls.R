# Qualified calls to names that duplicate inside the named package (no single valid target).

# `twice` is defined twice in ONE file of duplib (a redefinition); this file holds a decoy.
twice <- function(d) d

dup_same_file_user <- function(d) {
  duplib::twice(d)
}

# `across` is defined in two DIFFERENT files of duplib; this file holds a decoy.
across <- function(d) d

dup_cross_file_user <- function(d) {
  duplib::across(d)
}
