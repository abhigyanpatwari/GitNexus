# Nested function sharing a name with a later top-level function.
nested_outer <- function(d) {
  nest_fn <- function(x) x
  d |> nest_fn() |> stage_two(1)
}
nest_fn <- function(x) x
nested_caller <- function(d) {
  d |> nest_fn()
}
