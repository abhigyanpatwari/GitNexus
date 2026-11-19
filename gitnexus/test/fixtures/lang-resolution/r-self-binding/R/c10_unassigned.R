# c10: an R6Class call that is not assigned, and a RefClass method, give self no class to bind.
list(C10 = R6::R6Class("C10", public = list(c10_run = function() self$c10_other(), c10_other = function() 1)))
c10_other <- function() 2

# A RefClass method has no R6 self either (it uses .self).
c10_ref <- setRefClass("C10Ref", methods = list(c10_ref_run = function() self$c10_other()))
