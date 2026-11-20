e1 <- function() {
  local({ outerh <- function() "inner" })
  outerh()
}
