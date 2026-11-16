setClass("Circle", representation(r = "numeric"))
Circle <- function(r) new("Circle", r = r)
