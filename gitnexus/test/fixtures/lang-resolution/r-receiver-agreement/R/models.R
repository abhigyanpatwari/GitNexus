# R6 classes that share the method name `save`, so a receiver typed as the wrong class reaches a
# method of the right name on the wrong class.
User <- R6::R6Class("User", public = list(
  save = function() 1
))
Address <- R6::R6Class("Address", public = list(
  save = function() 2
))
Db <- R6::R6Class("Db", public = list(
  query = function() 3
))
