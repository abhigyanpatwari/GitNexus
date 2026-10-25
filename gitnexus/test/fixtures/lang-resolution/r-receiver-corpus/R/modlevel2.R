# A module-level constructor, then another value of the same name.
mv <- User$new()
mv <- make_user()

agree_module_rebound <- function() {
  mv$save()
}
