# c4: self$nothere() names no method of the class or its parents; a free function has that name.
C4Child <- R6::R6Class("C4Child",
  public = list(
    c4_run = function() self$c4_nothere()
  )
)
c4_nothere <- function() 2
