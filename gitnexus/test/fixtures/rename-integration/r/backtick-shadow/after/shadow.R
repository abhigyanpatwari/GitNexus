assist <- function(v) v + 1

outer <- function(x) {
  assist(x)
}

inner <- function(x) {
  `helper` <- function(y) y
  helper(x)
}
