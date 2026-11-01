a_main <- function(df) filter(df, x > 1)
a_ts <- function(x) lag(x)
a_mut <- function(df) mutate(df, y = 1)
a_priv <- function() 1
