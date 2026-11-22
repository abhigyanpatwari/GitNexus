# c13: a file that binds self itself: its free functions read that variable, not an R6 instance.
C13Global <- R6::R6Class("C13Global", public = list(c13_global_m = function() 1))
self <- C13Global$new()
c13_reads_global_self <- function() self$c13_global_m()
