area <- function(x) UseMethod("area")

area.circle <- function(x) 3.14 * x$r^2
