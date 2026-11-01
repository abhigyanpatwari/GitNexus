# The S4 sentinel keeps its placeholder edge. The R6 class that names an undefined
# `VIRTUAL` as its `inherit=` base is not the sentinel and gets none.
setClass("Abstract", representation(x = "numeric"), contains = "VIRTUAL")

Child <- R6::R6Class("Child", inherit = VIRTUAL, public = list(more = function() 2))
