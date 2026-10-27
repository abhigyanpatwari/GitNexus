helper <- function(x) x + 1
g <- function() {
  out <- 0
  for (i in 1:2) {
    out <- out + helper(1)
    helper <- function(x) 9
  }
  out
}
