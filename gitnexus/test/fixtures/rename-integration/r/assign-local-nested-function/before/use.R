helper <- function(v) v + 1

use <- function(x) {
  inner <- function(z) {
    helper <- function(y) 2
    helper(z)
  }
  helper(x)
}
