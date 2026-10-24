# Ordinary assignments bind a name in the function's own frame (probe cases d1-d16).
# Every caller is named `dN_f`; `helper` below is the outer function the edges must or must not reach.
helper <- function(x) 1
some_fn <- function() identity
missing <- function(x) 1

# d1: `<-` of a computed value
d1_f <- function(x) { helper <- identity; helper(x) }
# d2: `=`
d2_f <- function(x) { helper = identity; helper(x) }
# d3: a call result
d3_f <- function(x) { helper <- some_fn(); helper(x) }
# d4: the call comes before the assignment (flow-insensitive: documented as unresolved)
d4_f <- function(x) { helper(x); helper <- identity }
# d5: a conditional assignment
d5_f <- function(x) { if (x) helper <- identity; helper(x) }
# d6: control, the assigned value is a function literal (a real definition)
d6_f <- function(x) { helper <- function(y) 2; helper(x) }
# d7: right assignment
d7_f <- function(x) { identity -> helper; helper(x) }
# d9: control, a parameter
d9_f <- function(x, helper) { helper(x) }
# d11: a qualified call is not read through the local name
d11_f <- function(x) { helper <- identity; pkga::helper(x) }
# d12: the qualifier names nothing exported, and the bare call is shadowed
d12_f <- function(x) { missing <- identity; pkga::missing(x); missing(x) }
# d13: control, a constant is not a function, so R skips it at a call
d13_f <- function(x) { helper <- 2; helper(x) }
# d15: control, `<<-` assigns outward and does not bind here
d15_f <- function(x) { helper <<- identity; helper(x) }
# d16: a nested closure reads the enclosing function's local
d16_f <- function(x) { helper <- identity; d16_g <- function() helper(x); d16_g() }
# d17/d18: a parameter or a `for` variable of the qualified name does not hide the qualified call
d17_f <- function(x, helper) { pkga::helper(x) }
d18_f <- function(xs) { for (helper in xs) pkga::helper(1) }
