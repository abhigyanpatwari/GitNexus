ishown <- function() 1
ihidden <- function() 2
i_calls_outer <- function() ohidden()
i_calls_own <- function() ihidden()
