# c16: a parent's public field and a child's private method share a name. self$ reads the
# public side, the field, which is not callable here: no edge to the private method.
C16Base <- R6::R6Class("C16Base",
  public = list(
    c16_x = "field"
  )
)
C16Child <- R6::R6Class("C16Child",
  inherit = C16Base,
  public = list(
    c16_call = function() self$c16_x()
  ),
  private = list(
    c16_x = function() 2
  )
)
c16_x <- function() 3
