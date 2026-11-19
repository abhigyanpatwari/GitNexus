# A module-level constructor that a function of the same file rebinds with `<<-`: the module
# binding is no longer one constructor, so no function of this file reads it as a User.
mu <- User$new()

agree_module <- function() {
  mu$save()
}

agree_module_outward <- function() {
  mu <<- make_user()
  mu$save()
}
