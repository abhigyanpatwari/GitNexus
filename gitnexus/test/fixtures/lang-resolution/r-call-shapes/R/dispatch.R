area <- function(shape) UseMethod("area")
area.circle <- function(shape) NextMethod()
area.default <- function(shape) 0
use_area <- function(shape) area(shape)
