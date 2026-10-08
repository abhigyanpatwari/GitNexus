library(R6)
AdvancedR6 <- R6::R6Class("AdvancedR6",
  public = list(
    name = "default",
    active_count = 0L,
    initialize = function(name) {
      self$name <- name
    },
    get_name = function() {
      self$name
    }
  ),
  private = list(
    secret_key = NULL,
    internal_flag = TRUE,
    compute = function() {
      private$secret_key
    }
  ),
  active = list(
    display_name = function(value) {
      if (missing(value)) return(self$name)
      self$name <- value
    }
  )
)
