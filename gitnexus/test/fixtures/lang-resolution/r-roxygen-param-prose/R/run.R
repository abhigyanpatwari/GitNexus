Data <- R6::R6Class("Data",
  public = list(
    fit = function() 1
  )
)

#' Fit a model.
#'
#' @param df Data frame of observations
fit_from_prose <- function(df) {
  df$fit()
}

#' Fit a model from a freshly built object.
fit_from_constructor <- function() {
  d <- Data$new()
  d$fit()
}
