helper <- function(x) x + 1
Kid <- setRefClass("Kid", contains = "Base", methods = list(
  run = function(x) helper(x)
))
