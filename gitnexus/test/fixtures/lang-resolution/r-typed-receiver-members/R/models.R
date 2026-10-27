User <- R6::R6Class("User",
  public = list(
    save = function() 1,
    name = "x"
  ),
  private = list(
    secret = function() 2
  ),
  active = list(
    full = function(value) "full"
  )
)
Child <- R6::R6Class("Child", inherit = User, public = list(
  own = function() 3
))
Pub <- R6::R6Class("Pub", public = list(shared = function() 4))
Priv <- R6::R6Class("Priv", inherit = Pub, private = list(shared = function() 5))
