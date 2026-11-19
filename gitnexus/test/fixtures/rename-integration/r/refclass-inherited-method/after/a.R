helper <- function(x) x + 1
Base <- setRefClass("Base", methods = list(
  helper = function(x) 0
))
Kid <- setRefClass("Kid", contains = "Base", methods = list(
  run = function(x) helper(x)
))
