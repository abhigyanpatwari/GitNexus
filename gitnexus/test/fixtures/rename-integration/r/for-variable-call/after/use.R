helper <- function(v) v + 1

use <- function(xs) {
  for (helper in xs) helper(1)
}
