Parent <- R6::R6Class("Parent",
  public = list(
    greet = function() "hello",
    describe_it = function() "parent",
    climb_up = function() "parent"
  )
)

describe_it <- function() "top level"
