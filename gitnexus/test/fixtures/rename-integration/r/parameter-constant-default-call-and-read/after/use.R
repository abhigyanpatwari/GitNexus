helper <- function(v) v + 1

use <- function(x, helper = 2) {
  helper(x) + helper
}
