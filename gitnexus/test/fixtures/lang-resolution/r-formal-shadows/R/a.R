transform <- function(x) x + 1
validate <- function(x) x
callback <- function(x) x
handler <- function(x) x

apply_it <- function(data, transform) transform(data)

run_with <- function(data, validate) validate(data)

each_cb <- function(fns, d) {
  for (callback in fns) callback(d)
}

via_lapply <- function(xs) lapply(xs, function(handler) handler(1))

plain <- function(data) transform(data)

constant_default <- function(data, transform = 2) transform(data)

function_default <- function(data, validate = function(x) x) validate(data)
