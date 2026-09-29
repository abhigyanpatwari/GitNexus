print.foo <- function(x, ...) x
foo <- function(v) structure(list(v = v), class = "foo")

bar <- function(v) structure(list(v = v), class = "bar")
print.bar <- function(x, ...) x

baz <- function(v) v
summary.baz <- function(object, ...) object

qux <- function(v) v

`odd name` <- function(v) v
