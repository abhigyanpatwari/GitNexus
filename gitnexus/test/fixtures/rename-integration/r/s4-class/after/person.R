setClass("Person", representation(name = "character"))

make <- function() new("Person", name = "a")
