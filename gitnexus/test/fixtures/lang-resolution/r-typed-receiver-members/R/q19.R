# A typed receiver's dotted member with a free zero-argument function of that name in the file.
to.json <- function() "free"
Cls <- R6::R6Class("Cls", public = list(
  to.json = function() 1
))
q19 <- function() {
  c <- Cls$new()
  c$to.json()
}
