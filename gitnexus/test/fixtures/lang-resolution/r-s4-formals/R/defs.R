setClass("Base", representation("VIRTUAL"))

setClass(`Class` = "BacktickClass", contains = "Base")

setClass("Class" = "QuotedClass", contains = "Base")

setRefClass(`Class` = "BacktickRef", fields = list(n = "numeric"))

setGeneric(`name` = "backtickGeneric", def = function(x) standardGeneric("backtickGeneric"), valueClass = "numeric")

setClass("Plain", contains = "Base")

setMethod(`f` = "backtickMethod", signature = "Plain", definition = function(object) 1)
