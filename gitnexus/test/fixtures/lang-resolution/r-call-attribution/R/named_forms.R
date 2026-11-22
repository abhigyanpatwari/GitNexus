# Every file starts with a decoy first function: a call misattributed to the
# file's first callable shows up as an edge from `decoy_named`.
decoy_named <- function() leaf_a()

arrow_fn <- function(x) leaf_b(x)
equals_fn = function(x) leaf_c(x)
super_fn <<- function(x) leaf_d(x)
lambda_fn <- \(x) leaf_e(x)
dotted.name.fn <- function(x) leaf_f(x)
`backtick name fn` <- function(x) leaf_g(x)

pair_one <- function() leaf_h(1); pair_two <- function() leaf_i(2)

if (TRUE) cond_fn <- function() leaf_j(4)

default_arg_fn <- function(a = leaf_k(1)) {
  a
}

registry <- list()
registry$member_fn <- function(x) leaf_l(x)

res <- leaf_x(1)
