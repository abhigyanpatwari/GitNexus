assist <- function(v) v + 1

use <- function(x) assist(x)

other <- function(assist) assist * 2

config <- function(x, y = list(assist = 1)) {
  x$assist <- y$assist
  f(assist = x, pkg::assist)
  x
}
