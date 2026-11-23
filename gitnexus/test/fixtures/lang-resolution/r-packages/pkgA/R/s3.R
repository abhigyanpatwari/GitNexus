#' Generic description function
describe <- function(x) {
  UseMethod("describe")
}

describe.FancyWidget <- function(x) {
  x
}

#' @param widget FancyWidget widget under analysis
render_widget <- function(widget) {
  describe(widget)
}
