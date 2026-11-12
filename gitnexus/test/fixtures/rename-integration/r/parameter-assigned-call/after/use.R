helper <- function(v) v + 1

use <- function(x, helper = 2) {
  if (x > 0) helper <- identity
  helper(x)
}
