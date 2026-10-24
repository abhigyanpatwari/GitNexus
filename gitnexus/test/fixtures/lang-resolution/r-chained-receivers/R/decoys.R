# Free functions named like the last step of each chained call. A chain whose base is not known
# must never be bound to one of these (or to a method of the same name).
c <- function() "free c"
m <- function() "free m"
save <- function() "free save"
