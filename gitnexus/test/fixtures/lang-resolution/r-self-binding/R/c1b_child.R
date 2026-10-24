C1bChild <- R6::R6Class("C1bChild",
  inherit = C1bBase,
  public = list(
    c1b_run = function() self$c1b_greet()
  )
)
c1b_greet <- function() 2
