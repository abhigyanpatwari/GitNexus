setRefClass("Account",
  fields = list(balance = "numeric"),
  methods = list(
    deposit = function(x) {
      balance <<- balance + x
    },
    report = function() balance
  )
)

Person <- setRefClass("Person",
  methods = list(
    greet = function() "hi"
  )
)
