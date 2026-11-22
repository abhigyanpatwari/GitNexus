helper <- function(x) x + 1
Foo <- R6Class("Foo", public = list(
  run = function(x) helper(x)
), private = list(
  helper = function(x) x * 100
))
