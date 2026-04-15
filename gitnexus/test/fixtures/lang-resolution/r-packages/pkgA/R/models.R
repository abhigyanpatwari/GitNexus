# S4 class definition
setClass("DataModel", contains = "VIRTUAL", slots = list(
  name = "character",
  value = "numeric"
))

# R5 reference class
DataProcessor <- setRefClass("DataProcessor",
  fields = list(data = "data.frame"),
  methods = list(
    process = function() {
      self$data
    }
  )
)

# R6 class
library(R6)
ResultSet <- R6::R6Class("ResultSet",
  public = list(
    items = NULL,
    initialize = function(items = list()) {
      self$items <- items
    },
    count = function() {
      length(self$items)
    }
  )
)
