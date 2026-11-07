# c15: self$ reads the public members only; a private method is reached through private$.
C15Base <- R6::R6Class("C15Base",
  public = list(
    c15_shared = function() 1
  ),
  private = list(
    c15_hidden = function() 2
  )
)
C15Child <- R6::R6Class("C15Child",
  inherit = C15Base,
  public = list(
    c15_pub = function() 3,
    c15_call_pub = function() self$c15_pub(),
    c15_call_shared = function() self$c15_shared(),
    c15_call_hidden = function() self$c15_hidden(),
    c15_call_mine = function() self$c15_mine(),
    c15_priv_mine = function() private$c15_mine()
  ),
  private = list(
    c15_shared = function() 4,
    c15_mine = function() 5,
    c15_from_private = function() self$c15_pub()
  )
)
c15_hidden <- function() 6
c15_mine <- function() 7
c15_shared <- function() 8
