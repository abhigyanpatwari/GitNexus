assist <- function(x) x + 1
Foo <- setRefClass("Foo", methods = list(
  helper = function(x) x * 100,
  run = function(x) helper(x)
))
