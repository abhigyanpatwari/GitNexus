`%||%` <- function(x, y) if (is.null(x)) y else x

first <- function(x) x %||% 0
