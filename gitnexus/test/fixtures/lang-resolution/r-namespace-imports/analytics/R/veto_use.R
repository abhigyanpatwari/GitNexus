# Callers for the name-guess veto scenarios. Each lives in its own function so the exact
# call sets of the other fixture functions stay untouched.
mutate_user <- function(d) {
  mutate(d)
}

filter_user <- function(d) {
  filter(d)
}

dup_ext_user <- function(d) {
  dup_ext(d)
}

scripts_only_user <- function(d) {
  scripts_only_fn(d)
}
