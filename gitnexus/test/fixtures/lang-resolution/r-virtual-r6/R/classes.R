# An R6 class that happens to be named VIRTUAL, and an R6 class deriving from it:
# `inherit = VIRTUAL` is an ordinary base class, not the S4 sentinel.
VIRTUAL <- R6::R6Class("VIRTUAL", public = list(base = function() 1))

Child <- R6::R6Class("Child", inherit = VIRTUAL, public = list(more = function() 2))
