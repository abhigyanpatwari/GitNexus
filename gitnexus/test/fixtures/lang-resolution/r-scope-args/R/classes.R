setClass("Base", representation("VIRTUAL"))

setClass(
  # abstract
  "CommentVirtual", contains = "VIRTUAL")

setClass(
  # derived
  "CommentChild", contains = "Base", slots = list(n = "numeric"))

setClass("PlainVirtual", contains = "VIRTUAL")

setClass(contains = "Base", Class = "NamedFirstChild")

setClass(`Class` = "BacktickChild", contains = "Base", slots = list(m = "numeric"))

setClass("Class" = "QuotedChild", contains = "VIRTUAL")
