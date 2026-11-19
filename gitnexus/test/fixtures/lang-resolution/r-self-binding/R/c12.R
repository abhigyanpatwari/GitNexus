# c12: class spellings and where the R6Class call sits.
c12_dotted_greet <- function() 2
C12.Dotted <- R6::R6Class("C12.Dotted",
  public = list(
    c12_dotted_greet = function() 1,
    c12_dotted_run = function() self$c12_dotted_greet()
  )
)

`C12 Ticked` <- R6::R6Class("C12 Ticked",
  public = list(
    c12_ticked_greet = function() 1,
    c12_ticked_run = function() self$c12_ticked_greet()
  )
)

c12_factory <- function() {
  C12Inner <- R6::R6Class("C12Inner",
    public = list(
      c12_inner_greet = function() 1,
      c12_inner_run = function() self$c12_inner_greet()
    )
  )
  C12Inner$new()
}

# A dotted class name: inherited method and a missing method, each with a free function of that name.
C12.DBase <- R6::R6Class("C12.DBase", public = list(c12_dinh = function() 1))
C12.DChild <- R6::R6Class("C12.DChild",
  inherit = C12.DBase,
  public = list(
    c12_dinh_run = function() self$c12_dinh(),
    c12_dmissing_run = function() self$c12_dmissing()
  )
)
c12_dinh <- function() 2
c12_dmissing <- function() 2
