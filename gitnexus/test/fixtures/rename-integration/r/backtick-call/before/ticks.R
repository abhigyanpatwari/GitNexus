helper <- function(v) v + 1

step <- function(v) {
  helper(v)
  `helper`(v)
}
