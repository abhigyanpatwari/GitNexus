# S4: no call below is linked to a generic, a generator or a class.
setClass("Pt", representation(x = "numeric"))
Pt2 <- setClass("Pt2", representation(x = "numeric"))
setGeneric("area", function(shape) standardGeneric("area"))
setMethod("area", "Pt", function(shape) 1)

s4_generic_call <- function(p) {
  area(p)
}

s4_generator_call <- function() {
  Pt2(x = 1)
}

s4_new_call <- function() {
  new("Pt", x = 1)
}
