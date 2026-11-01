# Chains with an identifier base: the base's type is never followed.
chain_dollar_dollar <- function(a) {
  a$b$c()
}

chain_new_call <- function() {
  Cls$new()$m()
}

chain_typed_base <- function() {
  u <- User$new()
  u$save()
}

chain_typed_base_chain <- function() {
  u <- User$new()
  u$next_user$save()
}

chain_deep <- function(a) {
  a$b$c$d$m()
}

# The control: a plain receiver typed through its constructor.
control <- function() {
  u <- User$new()
  u$save()
}

# Chains with no identifier base: no site at all.
base_call <- function() {
  get_user()$save()
}

base_namespace_new <- function() {
  pkg::Cls$new()$m()
}

base_subset <- function(x) {
  x[[1]]$f$m()
}

base_subset_single <- function(x) {
  x[1]$save()
}

base_paren <- function(x) {
  (x)$f$save()
}

# Chains through a field initialised with a constructor and through a method returning self.
chain_field_instance <- function() {
  p <- Person$new()
  p$addr$save()
}

chain_method_result <- function() {
  p <- Person$new()
  p$me()$save()
}
