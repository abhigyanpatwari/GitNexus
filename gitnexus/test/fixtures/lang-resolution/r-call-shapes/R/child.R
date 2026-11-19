Child <- R6::R6Class("Child",
  inherit = Parent,
  public = list(
    greet = function() super$greet(),
    shout = function() self$greet(),
    inherited = function() self$describe_it(),
    ping = function() private$secret()
  ),
  private = list(
    secret = function() 1
  )
)

Remote <- R6::R6Class("Remote",
  inherit = basepkg::BasePkgClass,
  public = list(
    again = function() self$base_method()
  )
)

# A top-level function that shares the name of a method Parent defines.
climb_up <- function() "top level"

Climber <- R6::R6Class("Climber",
  inherit = Parent,
  public = list(
    up = function() self$climb_up()
  )
)
