# Method ids carry the parameter count (#n); a variadic method has none.

Acct <- R6::R6Class("Acct", public = list(
  reset = function() { 1 },
  show = function(x) { x },
  transfer = function(from, to, amount) { amount },
  deposit = function(amount, note = "x") { amount },
  log = function(amount, ...) { amount }
))

Wallet <- setRefClass("Wallet", methods = list(
  empty = function() { 1 },
  spend = function(x, y = 2) { x }
))
