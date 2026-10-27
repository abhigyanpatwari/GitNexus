Stack <- R6::R6Class("Stack",
  public = list(
    items = list(),
    push = function(x) NULL
  )
)

Config <- R6::R6Class("Config", public = list(verbose = FALSE, get = function() 1))
if (interactive()) {
  Config <- R6::R6Class("Config", public = list(verbose = TRUE, get = function() 2))
}

setClass("Circle", slots = c(r = "numeric"))
setMethod("area", "Circle", function(shape) 1)
