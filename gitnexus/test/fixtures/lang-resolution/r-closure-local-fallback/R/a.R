make_counter <- function() {
  count_fn <- function() 2
  count_fn
}

use_local <- function() count_fn()
