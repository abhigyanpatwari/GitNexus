pub <- function() 1
format_impl <- function(x, ...) render_line(x)
print.pkthing <- function(x, ...) render_line(x)
hidden.fn <- function() "private dotted"
render_line <- function(x) pad_text(x)
pad_text <- function(x) "registered"
