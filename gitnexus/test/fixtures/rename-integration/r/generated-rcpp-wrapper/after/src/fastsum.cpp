#include <Rcpp.h>
// [[Rcpp::export]]
double fastsum(Rcpp::NumericVector x) { return Rcpp::sum(x); }
