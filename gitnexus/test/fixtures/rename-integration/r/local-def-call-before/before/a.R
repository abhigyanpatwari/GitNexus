helper <- function(x) x + 1
g <- function() {
  r <- helper(1)
  helper <- function(x) 9
  r + helper(1)
}
