setClass("A", slots = c(x = "numeric"))
setClass("B", slots = c(y = "numeric"))
setClass("P", slots = c(p = "numeric"))

setMethod("show", signature("A"), function(object) cat("A"))
setMethod("show", signature(object = "B"), function(object) cat("B"))
setMethod("show", c("P", "A"), function(object) cat("P"))

setMethod("combine", signature("A", "A"), function(x, y) 1)
setMethod("combine", signature("B", "A"), function(x, y) 2)
