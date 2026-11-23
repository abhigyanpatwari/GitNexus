# Redefinition in the same file: the later definition wins in R.
twice <- function(d) d
twice <- function(d) d + 1

across <- function(d) d
