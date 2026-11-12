C5Child <- R6::R6Class("C5Child",
  inherit = C5Base,
  public = list(
    c5_run = function() self$c5_greet()
  )
)
