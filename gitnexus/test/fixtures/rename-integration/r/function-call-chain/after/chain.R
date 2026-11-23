assist <- function(v) v + 1

step <- function(v) {
  assist(assist(v))
}

# helper is described here
main <- function() {
  step(1)
}
