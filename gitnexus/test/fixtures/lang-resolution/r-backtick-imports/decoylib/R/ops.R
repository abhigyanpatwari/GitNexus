# Same names as provlib: a name-only guess cannot tell the two apart, so a call is attributed
# to provlib only through the importFrom() or the qualifier.
`%||%` <- function(a, b) b

`odd fn` <- function() 10

plain_fn <- function() 20

`shadowed_op` <- function() 30

`qualified_op` <- function() 40
