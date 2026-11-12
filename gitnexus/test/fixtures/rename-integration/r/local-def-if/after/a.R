helper <- function(x) x + 1
g <- function(flag) {
  if (flag) helper <- function(x) 9
  helper(1)
}
