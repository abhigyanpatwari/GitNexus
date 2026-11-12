# Definitions written in backticks keep their backticks on the node; NAMESPACE names the symbol.
`%||%` <- function(a, b) if (is.null(a)) b else a

`odd fn` <- function() 1

plain_fn <- function() 2

`shadowed_op` <- function() 3

# Called as provlib::qualified_op(), written without backticks.
`qualified_op` <- function() 4
