assist <- function(x) x + 1
Foo <- R6::R6Class("Foo", portable = FALSE, public = list(
  helper = function(x) x * 100,
  run = function(x) helper(x)
))
