test_that("stub", {
  helper <- function() "stub"
  expect_equal(helper(), "stub")
})
