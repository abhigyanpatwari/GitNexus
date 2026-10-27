# Dotted names: a dotted class gets no receiver lookup; a dotted member is not found by owner.
Base <- R6::R6Class("Base", public = list(inh = function() 1))
My.Class <- R6::R6Class("My.Class", inherit = Base, public = list(
  own = function() 2,
  c_own = function() self$own(),
  c_inh = function() self$inh(),
  c_missing = function() self$nothere()
))
data <- R6::R6Class("data", public = list(frame = function() 4))
Stack <- R6::R6Class("Stack", public = list(push = function(x) 5))
inh <- function() 0
nothere <- function() 0
