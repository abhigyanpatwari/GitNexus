helper <- function(v) v + 1

use <- function(x, cond) {
  if (cond) helper <- identity
  helper(x)
}
