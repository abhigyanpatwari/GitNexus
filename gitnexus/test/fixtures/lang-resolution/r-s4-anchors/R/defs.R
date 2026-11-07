setClass("Abstract", contains = "VIRTUAL", slots = list(label = "character"))

setRefClass("Ref", fields = list(count = "numeric"), contains = "Base")

setClass("Derived", contains = "Base", slots = list(size = "numeric"))

setGeneric("describe", function(x) standardGeneric("describe"), valueClass = "numeric")

setGeneric(name = "summarise", def = function(x) standardGeneric("summarise"))

setClass(Class = "Named", representation = representation(tag = "character"))

setMethod("show", "Derived", function(object) cat("derived"))

setMethod("describe", signature("Derived"), function(x) 1)
