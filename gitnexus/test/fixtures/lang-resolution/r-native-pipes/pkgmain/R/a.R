stage_one <- function(d) d
stage_two <- function(d, k) d
stage_three <- function(d, data) d
uniq_helper <- function(d) d
amb_stage <- function(d) d

# Module-level pipe: sourced from the File node.
piped_top <- c(1, 2) |> stage_one() |> stage_two(3)

# Placeholder argument: `_` is not a call and produces no edge.
placeholder_user <- function(df) {
  df |> stage_three(data = _)
}

# Lambda stage: the call inside the lambda belongs to the enclosing function.
lambda_user <- function(df) {
  df |> (\(d) uniq_helper(d))()
}

# Namespaced stage, unique name in another package (bound precisely by its qualifier).
ns_user <- function(df) {
  df |> pkgother::ext_fn() |> stage_one()
}

# Namespaced stage whose name is also defined in THIS file.
ns_amb_user <- function(df) {
  df |> pkgother::amb_stage()
}

# Multi-line chain, leading `|>` on continuation lines, builtin `paste` stage.
multiline_user <- function(df) {
  df |>
    stage_one() |>
    stage_two(2) |>
    paste("x") |>
    stage_three(data = _)
}

# R6 method chain ending in a self$ member stage.
Cls <- R6::R6Class("Cls", public = list(
  run = function(df) {
    df |> stage_one() |> self$post()
  },
  post = function(d) d
))

plain_user <- function(df) {
  uniq_helper(df)
}

# Member stage on an object of unknown type.
member_user <- function(obj, df) {
  df |> obj$method(1) |> stage_one()
}
