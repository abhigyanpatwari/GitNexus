test_that("x", {
  if (cond) helper <- function() 2
  expect_equal(helper(), 1)
})
