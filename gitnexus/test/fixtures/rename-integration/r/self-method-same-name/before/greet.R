greet <- function() 1

Base <- R6::R6Class("Base", public = list(greet = function() 1))
Child <- R6::R6Class("Child",
  inherit = Base,
  public = list(
    run = function() self$greet()
  )
)
