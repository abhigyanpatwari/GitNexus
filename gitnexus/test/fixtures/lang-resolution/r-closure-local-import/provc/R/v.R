process <- function(x) {
  validate <- function(y) stopifnot(is.numeric(y))
  validate(x)
  x
}
validate <- function(x) "exported"
solo <- function() "only one definition"
