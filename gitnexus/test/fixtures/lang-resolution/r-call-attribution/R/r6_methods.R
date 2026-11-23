decoy_r6 <- function() leaf_v()

Widget <- R6::R6Class("Widget",
  public = list(
    cache = leaf_w(),
    first = function() leaf_y(),
    run = function() {
      helper <- function() leaf_z()
      helper()
      lapply(1:3, function(i) leaf_aa(i))
    },
    relay = function() self$peer(),
    peer = function() leaf_ab()
  ),
  private = list(
    hidden = function() leaf_ac()
  ),
  active = list(
    shown = function() leaf_ad()
  )
)

Counter <- setRefClass("Counter", methods = list(
  bump = function() leaf_ae(),
  reset = function() leaf_af()
))
