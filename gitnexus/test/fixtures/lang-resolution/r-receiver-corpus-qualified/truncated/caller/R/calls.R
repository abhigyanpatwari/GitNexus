# Package discovery stops at directory depth 3, so the package under deep/a/b/c/ is never found:
# whether `invisiblepkg` is local is UNKNOWN, and the qualified site is dropped.
fmt <- function() "caller fmt"

q_unknown <- function() invisiblepkg::fmt()

# Positive control: a plain call of the caller's own `fmt`.
q_local <- function() fmt()
