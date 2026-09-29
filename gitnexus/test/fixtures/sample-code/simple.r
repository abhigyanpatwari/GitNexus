library(R6)
source("helpers.R")

#' Add two numbers.
#' @param a numeric first operand
#' @param b numeric second operand
#' @export
add <- function(a, b) {
  a + b
}

private_helper <- function() {
  0
}

setClass("Point", representation(x = "numeric", y = "numeric"))

setGeneric("distance", function(obj, other) standardGeneric("distance"))

setMethod("distance", "Point", function(obj, other) {
  abs(obj@x - other@x) + abs(obj@y - other@y)
})

Counter <- R6::R6Class("Counter",
  public = list(
    count = 0,
    increment = function() {
      self$count <- self$count + 1
      invisible(self)
    }
  )
)

run <- function() {
  counter <- Counter$new()
  counter$increment()
  c(1, 2, 3) |> add(4) |> private_helper()
  stats::median(c(1, 2, 3))
}
