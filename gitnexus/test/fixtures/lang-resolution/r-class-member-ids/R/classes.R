# Several classes in one file whose members share names. Each member must be its own
# node, owned by its own class.

Stack <- R6::R6Class("Stack", public = list(
  items = list(),
  initialize = function() { self$items <- list() },
  push = function(x) { self$items <- c(self$items, x); invisible(self) },
  twice = function(x) { self$push(x); self$push(x) }
))

Queue <- R6::R6Class("Queue", public = list(
  items = list(),
  initialize = function() { self$items <- list() },
  push = function(x) { self$items <- c(self$items, x); invisible(self) },
  twice = function(x) { self$push(x); self$push(x) }
))

Account <- setRefClass("Account",
  fields = list(balance = "numeric"),
  methods = list(deposit = function(x) { balance <<- balance + x })
)

Wallet <- setRefClass("Wallet",
  fields = list(balance = "numeric"),
  methods = list(deposit = function(x) { balance <<- balance + x })
)

setClass("Circle", slots = list(size = "numeric"))
setClass("Square", slots = list(size = "numeric"))

setGeneric("area", function(shape) standardGeneric("area"))
setMethod("area", "Circle", function(shape) 1)
setMethod("area", "Square", function(shape) 2)
