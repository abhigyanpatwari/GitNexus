Scorer <- R6::R6Class("Scorer",
  public = list(
    # Method defined BEFORE the top-level function of the same name.
    score_it = function(d) d
  )
)

score_it <- function(d) d

Reporter <- R6::R6Class("Reporter",
  public = list(
    # Only a method: no top-level function carries this name.
    describe_run = function(d) d
  )
)
