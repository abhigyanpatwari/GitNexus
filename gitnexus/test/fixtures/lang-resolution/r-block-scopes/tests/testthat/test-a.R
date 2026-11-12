test_that("a", {
  mockme <- function() "stub"
  mockme()
})
test_that("b", {
  mockme()
})
describe("d", {
  it("i", {
    desc_helper <- function() 1
  })
})
local({
  loc_helper <- function() 2
})
with(list(), {
  with_helper <- function() 3
})
withr::with_options(list(), {
  withr_helper <- function() 4
})
suppressWarnings({
  sw_helper <- function() 5
})
build_fixture_a <- NULL
test_that("fixture", {
  build_fixture <- function() 6
})
within(list(), {
  within_helper <- function() 7
})
testthat::test_that("ns", {
  ns_helper <- function() 8
})
