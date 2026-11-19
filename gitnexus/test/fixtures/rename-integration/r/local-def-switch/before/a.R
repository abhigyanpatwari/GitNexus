helper <- function(x) x + 1
g <- function(k) {
  switch(k, a = { helper <- function(x) 9 }, b = NULL)
  helper(1)
}
