helper <- function(v) v + 1

use <- function(x, helper = function(z) z) {
  helper(x)
}
