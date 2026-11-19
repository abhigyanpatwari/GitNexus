# c6, c7, c8: private$, super$ and an ordinary object receiver never bind a free function.
C6Base <- R6::R6Class("C6Base",
  public = list(c7_greet = function() 1),
  private = list(c6_secret = function() 1)
)
C6Child <- R6::R6Class("C6Child",
  inherit = C6Base,
  public = list(
    c6_run = function() private$c6_secret(),
    c7_greet = function() super$c7_greet()
  )
)
c6_secret <- function() 2
c8_greet <- function() 2
c8_use <- function(obj) obj$c8_greet()
