#' Add outlier statuses to data
#'
#' @param data DataFrame the input data
#' @param outliers DataFrame outlier records
#' @return DataFrame with outlier statuses added
#' @export
AddOutlierStatuses <- function(data, outliers) {
  clean <- pkgB::CleanData(data)
  result <- merge(clean, outliers, by = "id", all.x = TRUE)
  result
}
