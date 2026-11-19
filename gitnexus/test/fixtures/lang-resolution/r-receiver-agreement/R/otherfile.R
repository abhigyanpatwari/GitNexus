# A module binding of another file is not read here.
o1 <- function() u$save()
# Frames are per file: `reset()` in otherfile-reset.R rebinds `con` with `<<-`, which this file
# does not see, so q1 keeps its edge (limit).
con <- Db$new()
q1 <- function() con$query()
