# Standalone script using source() and library()
source("pkgA/R/utils.R")
library("pkgB")

result <- HelperFunc(42)
clean <- CleanData(result)
print(clean)

# R6 method call resolution
rs <- ResultSet$new(list(1, 2, 3))
n <- rs$count()

# require() should resolve identically to library()
require("pkgA")
