# slots / fields given as c(...) rather than list(...).
setClass("Person", slots = c(name = "character", age = "numeric"))
setClass("Tagged", slots = c("tag", "weight"))
Account <- setRefClass("Account", fields = c(balance = "numeric"))
Ledger <- setRefClass("Ledger", fields = c("entries"))
