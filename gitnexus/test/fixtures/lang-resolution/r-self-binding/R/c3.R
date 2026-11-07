# c3: the class's own method, with a free function of the same name.
C3Child <- R6::R6Class("C3Child",
  public = list(
    c3_greet = function() 1,
    c3_run = function() self$c3_greet()
  )
)
c3_greet <- function() 2
