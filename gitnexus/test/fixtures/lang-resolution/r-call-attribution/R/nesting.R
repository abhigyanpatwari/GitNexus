decoy_nesting <- function() leaf_m()

outer <- function(x) {
  inner <- function(y) leaf_n(y)
  inner(x)
  lapply(x, function(z) leaf_o(z))
  sapply(x, FUN = function(z) leaf_p(z))
  tryCatch(leaf_q(x), error = function(e) leaf_r(e))
}

level1 <- function() {
  level2 <- function() {
    level3 <- function() leaf_s()
    level3()
    leaf_t()
  }
  level2()
  leaf_u()
}
