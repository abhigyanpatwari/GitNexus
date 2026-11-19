# The caller defines its own `fmt`: a decoy no qualified call may reach.
fmt <- function() 0
l_reexport <- function() pkga::fmt()
l_ext_origin <- function() pkgx::fmt()
l_dup_origin <- function() pkgd::fmt()
l_external <- function() ext::fmt()
l_two_hop <- function() pkgh::fmt()
