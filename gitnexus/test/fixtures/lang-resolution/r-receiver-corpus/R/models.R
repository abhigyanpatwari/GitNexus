library(R6)

User <- R6Class("User",
  public = list(
    save = function() "User.save"
  )
)

# The one documented form the type extractor accepts: the type alone, a class of this file, a
# formal of the documented function. No edge reads it.
#' @param repo User
roxygen_param <- function(repo) {
  repo$save()
}

Address <- R6Class("Address",
  public = list(
    save = function() "Address.save"
  )
)

Base <- R6Class("Base",
  public = list(
    greet = function() "Base.greet"
  )
)

# `self` cells: one method per cell, so the call sites never share a caller name.
Child <- R6Class("Child",
  inherit = Base,
  public = list(
    climb_up = function() "Child.climb_up",
    self_own = function() self$climb_up(),
    self_inherited = function() self$greet(),
    self_missing = function() self$nothere(),
    super_call = function() super$greet(),
    private_call = function() private$secret()
  ),
  private = list(
    secret = function() "Child.secret"
  )
)

# A field holding another object: `self$repo$save()` is a chain, not a typed receiver.
Service <- R6Class("Service",
  public = list(
    repo = NULL,
    self_field_chain = function() self$repo$save()
  )
)

# RefClass: a method calling a sibling by bare name, or through .self, is not bound to it.
Logger <- setRefClass("Logger",
  methods = list(
    log_bare = function(x) x,
    log_dot = function(x) x,
    log_decoy = function(x) x,
    refclass_bare = function(x) log_bare(x),
    refclass_dot_self = function(x) .self$log_dot(x),
    refclass_bare_decoy = function(x) log_decoy(x)
  )
)
