# c14: writing through self (`self$x <- v`, `self[["x"]] <- v`, `self$x[[i]] <- v`,
# `names(self$x) <- v`) leaves self the instance; a plain `self <- ...` rebinds it.
C14Base <- R6::R6Class("C14Base",
  public = list(
    c14_greet = function() 1
  )
)
C14Child <- R6::R6Class("C14Child",
  inherit = C14Base,
  public = list(
    count = 0,
    items = NULL,
    c14_own = function() 1,
    c14_run_own = function() {
      self$count <- 1
      self$c14_own()
    },
    c14_run_inherited = function() {
      self$count <- 1
      self$c14_greet()
    },
    c14_run_missing = function() {
      self$count <- 1
      self$c14_nothere()
    },
    c14_run_elem = function(i, v) {
      self$items[[i]] <- v
      self$c14_own()
    },
    c14_run_dbl = function(v) {
      self[["count"]] <- v
      self$c14_own()
    },
    c14_run_repl = function(v) {
      names(self$items) <- v
      self$c14_own()
    },
    c14_rebind = function() {
      self <- c14_other()
      self$c14_own()
    },
    c14_rebind_ctor = function() {
      self <- C14Base$new()
      self$c14_own()
    }
  )
)
c14_own <- function() 2
c14_greet <- function() 2
c14_nothere <- function() 2
c14_other <- function() 2
