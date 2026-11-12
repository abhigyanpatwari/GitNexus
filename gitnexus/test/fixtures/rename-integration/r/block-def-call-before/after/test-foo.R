test_that("x", {
  expect_equal(helper(), 1)
  helper <- function() "stub"
})
