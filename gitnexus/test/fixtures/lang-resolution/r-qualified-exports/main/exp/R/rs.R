# A private R6 class: exp exports only `shown`.
ResultSet <- R6::R6Class("ResultSet",
  public = list(
    count = function() 1
  )
)
