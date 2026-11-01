u5 <- function() {
  m <- My.Class$new()
  m$inh()
}
u6 <- function() {
  m <- My.Class$new()
  m$own()
}
# A dotted free call reaches an R6 method whose qualified name matches (limit, no R-only route).
u2 <- function(x) data.frame(x)
u3 <- function(x) Stack.push(x)
