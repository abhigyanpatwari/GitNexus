# Explicitly qualified call to a package the NAMESPACE does not import it from.
qualified_user <- function(d) {
  legacyscore::tidy_scores(d)
}
