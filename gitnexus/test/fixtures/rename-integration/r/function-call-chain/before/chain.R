helper <- function(v) v + 1

step <- function(v) {
  helper(helper(v))
}

# helper is described here
main <- function() {
  step(1)
}
