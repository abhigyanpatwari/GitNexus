assist <- function(x) x + 1
Base <- setRefClass("Base", methods = list(other = function() 1))
Kid <- setRefClass("Kid", contains = "Base", methods = list(
  run = function(x) assist(x)
))
