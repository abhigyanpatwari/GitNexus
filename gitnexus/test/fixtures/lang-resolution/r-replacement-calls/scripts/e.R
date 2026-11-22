# Getter, setter and a decoy defined for foo, bar, names and attr. Every caller `eN_x` makes
# one call shape; the name says which cell of the test table it is.
foo <- function(x) 1
bar <- function(x) 2
names <- function(x) 3
attr <- function(x, which) 4
`foo<-` <- function(x, value) x
`bar<-` <- function(x, value) x
`names<-` <- function(x, value) x
`attr<-` <- function(x, which, value) x

f_simple <- function(x) { foo(x) <- 1 }
f_eq <- function(x) { foo(x) = 1 }
f_super <- function(x) { foo(x) <<- 1 }
f_right <- function(x) { 1 -> foo(x) }
f_right_super <- function(x) { 1 ->> foo(x) }
f_nested <- function(x) { foo(bar(x)) <- 1 }
f_dollar_on_call <- function(x) { foo(x)$a <- 1 }
f_index_on_call <- function(x) { foo(x)[1] <- 2 }
f_index_arg_of_call_base <- function(x) { foo(x)[bar(1)] <- 2 }
f_rhs <- function(x) { y <- foo(x) }
f_rhs_both <- function(x) { foo(x) <- bar(x) }
f_index_arg <- function(x) { x[bar(1)] <- 1 }
f_names <- function(x) { names(x) <- "a" }
f_attr <- function(x) { attr(x, "a") <- 1 }
f_dollar <- function(x) { x$a <- 1 }
f_idx <- function(x) { x[1] <- 2 }
f_extra_arg_call <- function(x) { foo(x, bar(1)) <- 1 }
f_second_arg_chain <- function(x) { foo(x, bar(1)) <- bar(x) }
f_explicit <- function(x) { `foo<-`(x, 1) }
f_str_explicit <- function(x) { "foo<-"(x, 1) }
f_backtick_getter <- function(x) { `foo`(x) <- 1 }
f_plain_read <- function(x) { foo(x) }
f_pipe_read <- function(x) { x |> foo() }
f_nested_function <- function(x) { foo(function(y) bar(y)) <- 1 }
