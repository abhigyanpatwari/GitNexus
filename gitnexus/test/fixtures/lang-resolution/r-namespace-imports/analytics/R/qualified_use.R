# Explicitly qualified call to a package the NAMESPACE does not import it from.
qualified_user <- function(d) {
  legacyscore::tidy_scores(d)
}

# Correctly qualified call to the package that really defines `mutate`, while the
# NAMESPACE imports `mutate` from dplyr.
qualified_mutate_user <- function(d) {
  legacyscore::mutate(d)
}
