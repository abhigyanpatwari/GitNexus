# c13b: the self object is bound in another file (R/c13.R). The provider does not follow it, so this
# call has no edge (documented limit R-14 in docs/languages/r-ingestion-gaps.md).
c13b_reads_global_self <- function() self$c13_global_m()
