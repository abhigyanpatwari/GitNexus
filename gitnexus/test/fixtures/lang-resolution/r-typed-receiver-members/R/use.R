# A private member is not on a typed receiver (R6 public interface). No edge.
p1 <- function() {
  u <- User$new()
  u$secret()
}
# Private in the parent. No edge.
p2 <- function() {
  c <- Child$new()
  c$secret()
}
# The child's private member does not hide the parent's public one: Pub.shared.
p3 <- function() {
  p <- Priv$new()
  p$shared()
}
# An active binding: R runs the active function on access, so the edge to it stays.
a1 <- function() {
  u <- User$new()
  u$full()
}
# `@` on an R6 instance errors in R: no site.
s1 <- function() {
  u <- User$new()
  u@save()
}
# A generator object does not carry instance methods. No edge.
g1 <- function() User$save()
g2 <- function() Child$own()
# A field called as a function: no edge.
f1 <- function() {
  u <- User$new()
  u$name()
}
# The positive control.
ctl <- function() {
  u <- User$new()
  u$save()
}
