# c11: the call's argument count differs from the method's formals (R allows missing and `...`).
C11Base <- R6::R6Class("C11Base",
  public = list(
    c11_two = function(a, b) 1,
    c11_dots = function(...) 1,
    c11_none = function() 1
  )
)
C11Child <- R6::R6Class("C11Child",
  inherit = C11Base,
  public = list(
    c11_few = function() self$c11_two(1),
    c11_many = function() self$c11_none(1, 2, 3),
    c11_spread = function() self$c11_dots(1, 2, 3)
  )
)
c11_two <- function(a, b) 2
c11_dots <- function(...) 2
c11_none <- function() 2
