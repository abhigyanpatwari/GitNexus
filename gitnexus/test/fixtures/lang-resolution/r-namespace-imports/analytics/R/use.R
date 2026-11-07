run_all <- function(d) {
  tidy_scores(d)
  normalise_scores(d)
  rank_scores(d)
  quoted_fn(d)
  own_dup(d)
  dup_fn(d)
  hidden_helper(d)
  no_such_fn(d)
  d
}
