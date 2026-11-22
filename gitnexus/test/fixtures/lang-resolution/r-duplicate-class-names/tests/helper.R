Stack <- R6::R6Class("Stack",
  public = list(
    count = 0,
    pop = function() NULL
  )
)

setClass("Circle", slots = c(radius = "numeric"))
setMethod("perimeter", "Circle", function(shape) 2)
