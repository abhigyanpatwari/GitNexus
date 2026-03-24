func main() {
    let svc = PublicService()
    svc.doWork()
    internalHelper()
    secretHelper()
    fileOnlyHelper()
}
