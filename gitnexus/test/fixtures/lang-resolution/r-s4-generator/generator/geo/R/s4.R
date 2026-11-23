setGeneric("area", function(shape) standardGeneric("area"))
Circle <- setClass("Circle", representation(r = "numeric"))
setMethod("area", "Circle", function(shape) pi * shape@r^2)
