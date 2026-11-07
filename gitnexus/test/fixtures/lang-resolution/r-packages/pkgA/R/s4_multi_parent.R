setClass("BaseA", slots = list(a_field = "numeric"))
setClass("BaseB", slots = list(b_field = "character"))
setClass("MultiChild", contains = c("BaseA", "BaseB"))
