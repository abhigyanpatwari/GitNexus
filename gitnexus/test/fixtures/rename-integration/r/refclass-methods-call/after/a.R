helper <- function() 1
Foo <- setRefClass("Foo", methods = list(helper = function() 100))
Foo$methods(run = function() helper())
