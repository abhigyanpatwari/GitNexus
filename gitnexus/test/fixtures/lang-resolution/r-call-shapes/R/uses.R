# Positive control: a plain call links.
direct_call <- function() helper(1)

# None of the shapes below is a call to `helper` the provider captures.
via_lapply <- function(xs) lapply(xs, helper)
via_map <- function(xs) Map(helper, xs, xs)
via_do_call <- function() do.call("helper", list(1))
via_match_fun <- function() match.fun("helper")(1)
via_get <- function() get("helper")(1)
via_registry <- function() {
  handlers <- list(a = helper)
  handlers[["a"]](1)
}
via_qualified_value <- function(xs) lapply(xs, shapes::helper)

# An infix operator is not linked to its definition.
via_infix <- function(a, b) a %+% b

# S4 slot access is not a call.
via_slot <- function(p) p@name
