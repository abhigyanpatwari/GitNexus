# c9: self outside an R6 method is not the class instance.
c9_nothere <- function() 2
c9_free <- function() self$c9_nothere()
c9_param <- function(self) self$c9_nothere()

C9Holder <- R6::R6Class("C9Holder",
  public = list(
    c9_own = function() 1,
    # A closure inside a method sees the method's self.
    c9_nested = function() lapply(1:2, function(i) self$c9_own()),
    # A method calling a method that does not exist: no free function of that name is reached.
    c9_missing = function() self$c9_nothere()
  )
)
