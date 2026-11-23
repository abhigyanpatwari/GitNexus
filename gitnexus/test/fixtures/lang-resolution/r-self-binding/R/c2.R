# c2: an inherited method, no free function of that name.
C2Base <- R6::R6Class("C2Base", public = list(c2_greet = function() 1))
C2Child <- R6::R6Class("C2Child",
  inherit = C2Base,
  public = list(
    c2_run = function() self$c2_greet()
  )
)
