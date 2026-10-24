# First function of the package in load order: a decoy that must own only its
# own pipe edge, never the edges of pipes written in later functions/files.
decoy_first <- function(d) {
  d |> uniq_helper()
}
