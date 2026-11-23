# `Circle` is also a Python class. Its R members still belong to the R class.
setClass("Circle", slots = list(radius = "numeric"))
setMethod("area", "Circle", function(shape) 1)

# `Square` is defined only in Python here (the R class would come from another
# package), so this method has no R owner and must not attach to the Python class.
setMethod("perimeter", "Square", function(shape) 4)
