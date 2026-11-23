assist <- function(x) x + 1
r <- function(x) {
  message("calling helper now")
  assist(x)
}
