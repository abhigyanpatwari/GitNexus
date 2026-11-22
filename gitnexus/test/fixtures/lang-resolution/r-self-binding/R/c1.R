# c1: an inherited method called through self, with a free function of the same name beside it.
C1Base <- R6::R6Class("C1Base", public = list(c1_greet = function() 1))
C1Child <- R6::R6Class("C1Child",
  inherit = C1Base,
  public = list(
    c1_run = function() {
      self$c1_greet()
    }
  )
)
c1_greet <- function() 2
