# S4 generic and method
setGeneric("validate", function(object, ...) standardGeneric("validate"))
setMethod("validate", "DataModel", function(object, ...) {
  length(object@name) > 0
})

# R6 base class
Parent <- R6::R6Class("Parent",
  public = list(
    greet = function() "hi"
  )
)

# R6 with inheritance
Child <- R6::R6Class("Child",
  inherit = Parent,
  public = list(
    greet = function() "hello"
  )
)

# Functions used by pipe-chain resolution tests
clean_native <- function(data) {
  data
}

transform_native <- function(data) {
  data
}

clean_magrittr <- function(data) {
  data
}

transform_magrittr <- function(data) {
  data
}

# Pipe usage
result <- data |> clean_native() |> transform_native()
result2 <- data %>% clean_magrittr() %>% transform_magrittr()
