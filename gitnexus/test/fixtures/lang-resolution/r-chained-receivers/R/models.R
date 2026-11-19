library(R6)

User <- R6Class("User",
  public = list(
    save = function() "User.save"
  )
)

# An unrelated class whose methods share the names of the calls below.
Other <- R6Class("Other",
  public = list(
    c = function() "Other.c",
    m = function() "Other.m"
  )
)

Cls <- R6Class("Cls",
  public = list(
    m = function() "Cls.m"
  )
)

Holder <- R6Class("Holder",
  public = list(
    f = NULL,
    run = function() {
      self$f$m()
    }
  )
)

# A field initialised with a constructor call, and a method returning self: the shapes where a
# typed walk of the chain could succeed.
Address <- R6Class("Address",
  public = list(
    save = function() "Address.save"
  )
)

Person <- R6Class("Person",
  public = list(
    addr = Address$new(),
    me = function() invisible(self)
  )
)
