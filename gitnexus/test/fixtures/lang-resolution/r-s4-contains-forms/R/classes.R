# `contains` is matched case-sensitively, as R matches argument names: `CONTAINS =` links nothing.
setClass("Base", representation(x = "numeric"))

# Both a real base and the VIRTUAL sentinel: each gets its own EXTENDS edge.
setClass("Both", contains = c("Base", "VIRTUAL"))

# The sentinel written first, then a real base.
setClass("SentinelFirst", contains = c("VIRTUAL", "Base"))

setClass("Shouted", CONTAINS = "Base")
