helper <- function(x) x + 1
Foo <- R6::R6Class("Foo", public = list(
  run = function(x) helper(x)
), active = list(
  helper = function(value) 100
))
