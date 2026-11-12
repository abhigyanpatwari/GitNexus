top_helper <- function() 1

other <- function() {
  inner_only <- function() top_helper()
  inner_only()
}

reach_inner <- function() inner_only()
reach_top <- function() top_helper()
