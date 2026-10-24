helper <- function(v) v + 1

use <- function(x) {
  y <- helper(x)
  helper <- identity
  y
}
