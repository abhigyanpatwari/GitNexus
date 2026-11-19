# R6 class via bare R6Class() call (no R6:: namespace prefix)
BareR6 <- R6Class("BareR6",
  public = list(
    value = 42,
    get_value = function() {
      self$value
    }
  ),
  inherit = Parent
)
