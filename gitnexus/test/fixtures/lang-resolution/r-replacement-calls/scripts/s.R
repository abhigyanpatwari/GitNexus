# A setter that no definition node stands for: string-spelled and S4 setters.
baz <- function(x) 1
"baz<-" <- function(x, value) x
g_string_setter <- function(x) { baz(x) <- 1 }

qux <- function(x) 1
setReplaceMethod("qux", "Cls", function(x, value) x)
g_s4_setter <- function(x) { qux(x) <- 1 }
