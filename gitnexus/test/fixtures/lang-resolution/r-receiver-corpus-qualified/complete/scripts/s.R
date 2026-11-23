# The caller defines its own `fmt`: a decoy no qualified call to another package may reach.
fmt <- function() "caller fmt"

# pkga re-exports other's `fmt` (importFrom plus export): the edge goes to the origin.
q_reexport <- function() pkga::fmt()

# A package that is certainly not in the repository.
q_external <- function() ext::fmt()

# Positive control: a package that defines and exports `fmt` itself.
q_direct <- function() other::fmt()

# Positive control: a plain call of the caller's own `fmt`.
q_local <- function() fmt()
