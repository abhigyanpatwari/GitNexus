decoy_s4 <- function() leaf_ag()

setClass("Sq", representation(side = "numeric"))
setGeneric("area", function(shape) standardGeneric("area"))
setMethod("area", "Sq", function(shape) leaf_ah(shape))
setClass("P", representation(x = "numeric"), validity = function(object) leaf_ai(object))
