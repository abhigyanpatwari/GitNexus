use_other <- function() count_fn()

use_top <- function() top_helper()

wrap <- function() {
  shared_name <- function() 2
  shared_name()
}
