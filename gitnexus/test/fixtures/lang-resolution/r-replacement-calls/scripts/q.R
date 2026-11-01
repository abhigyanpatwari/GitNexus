# Qualified replacement calls. pkga exports `foo<-` written with backticks, pkgb writes the quoted
# spelling, pkgc exports only the getter. Each package defines a getter and a setter.
q_backtick <- function(x) { pkga::foo(x) <- 1 }
q_quoted <- function(x) { pkgb::foo(x) <- 1 }
q_private <- function(x) { pkgc::foo(x) <- 1 }
q_private_triple <- function(x) { pkgc:::foo(x) <- 1 }
q_right <- function(x) { 1 -> pkga::foo(x) }
q_nested <- function(x) { pkga::foo(pkga::foo(x)) <- 1 }
q_read <- function(x) { pkga::foo(x) }
