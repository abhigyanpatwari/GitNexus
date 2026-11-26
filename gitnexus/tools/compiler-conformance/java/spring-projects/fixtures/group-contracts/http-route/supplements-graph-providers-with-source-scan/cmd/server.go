
package main

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
