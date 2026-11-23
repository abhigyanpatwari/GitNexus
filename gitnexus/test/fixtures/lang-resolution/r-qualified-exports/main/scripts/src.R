# R puts the names of a sourced file in the global environment, so `hidden()` binds here.
source("../exp/R/a.R")
src_hidden <- function() hidden()
