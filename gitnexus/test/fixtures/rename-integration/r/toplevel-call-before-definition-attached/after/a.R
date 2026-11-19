library(dplyr)
x <- filter(df, a > 1)
filter <- function(...) "mine"
y <- filter(1)
