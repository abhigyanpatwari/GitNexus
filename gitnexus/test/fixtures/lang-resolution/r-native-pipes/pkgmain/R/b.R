Type <- R6::R6Class("Type", public = list(
  score = function(d) d
))

# Member stage on a typed local (constructed via Type$new()).
typed_user <- function(df) {
  obj <- Type$new()
  df |> obj$score() |> stage_one()
}

# Backticked stage with no definition anywhere.
bt_user <- function(df) {
  df |> `my fn`() |> stage_two(1)
}

# Same name defined in both other packages (fork #7).
ns_amb2_user <- function(df) {
  df |> pkgother::amb_only() |> pkgthird::amb_only()
}
