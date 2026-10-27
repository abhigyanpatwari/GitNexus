test_that("a", {
  u <- User$new()
  u$save()
})
test_that("b", {
  u$greet()
})
