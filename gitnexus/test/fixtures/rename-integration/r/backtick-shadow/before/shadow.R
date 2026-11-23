helper <- function(v) v + 1

outer <- function(x) {
  helper(x)
}

inner <- function(x) {
  `helper` <- function(y) y
  helper(x)
}
