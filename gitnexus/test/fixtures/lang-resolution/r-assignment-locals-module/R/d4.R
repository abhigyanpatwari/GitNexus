outer <- function(x) x
local({
  outer <- identity
  inside <- function() outer(1)
})
local({
  outside <- function() outer(1)
})
