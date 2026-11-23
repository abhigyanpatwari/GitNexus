helper <- function(x) x + 1
g <- function() {
  k <- function() helper(1)
  r <- k()
  helper <- function(x) 9
  r
}
