helper <- function(v) v + 1

install <- function() {
  helper <<- function(z) z * 2
}

use_helper <- function() {
  helper(1)
}
