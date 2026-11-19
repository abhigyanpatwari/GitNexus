Account <- R6::R6Class("Account",
  public = list(
    balance = 0,
    deposit = function(n) {
      self$balance <- self$balance + n
      invisible(self)
    }
  )
)

acc <- Account$new()
