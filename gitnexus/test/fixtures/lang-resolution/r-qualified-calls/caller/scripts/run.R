# Outside any package R/ directory. `library(altlib)` attaches altlib, but the call is
# explicitly qualified with locallib.
library(altlib)

script_result <- locallib::libshared(1)
