#' Clean input data
#'
#' @param raw_data DataFrame the raw data
#' @return DataFrame cleaned data
#' @export
CleanData <- function(raw_data) {
  raw_data[complete.cases(raw_data), ]
}
