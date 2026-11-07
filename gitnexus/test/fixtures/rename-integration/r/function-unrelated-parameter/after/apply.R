apply_twice <- function(compute, v) {
  compute(compute(v))
}
