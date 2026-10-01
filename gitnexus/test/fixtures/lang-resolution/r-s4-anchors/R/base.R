# Base class defined in its own file: a `contains = "Base"` elsewhere must not
# mint a second Class named Base.
setClass("Base", representation("VIRTUAL"))
