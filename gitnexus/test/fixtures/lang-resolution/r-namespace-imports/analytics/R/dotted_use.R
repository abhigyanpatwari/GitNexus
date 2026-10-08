dotted_name_user <- function(d) {
  normalise.scores(d)
}

print_before_bare_user <- function(d) {
  tidy(d)
}

bare_before_print_user <- function(d) {
  tally(d)
}

underscore_user <- function(d) {
  plain_fn(d)
}
