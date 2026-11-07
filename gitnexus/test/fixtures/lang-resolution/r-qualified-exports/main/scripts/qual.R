# `ghost` is NOT defined by `exp`; the same-file definition below is a decoy.
ghost <- function() 9
a1_call <- function() exp::ghost()
a3_call <- function() exp:::ghost()
a1_ctrl <- function() exp::shown()
