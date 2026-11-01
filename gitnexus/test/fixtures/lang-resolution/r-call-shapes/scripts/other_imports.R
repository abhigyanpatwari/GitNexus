import::from("shapes", helper)
loadNamespace("shapes")
attachNamespace("shapes")
sys.source("R/helpers.R", envir = environment())
box::use(shapes[helper])
script_fn <- function() 1
