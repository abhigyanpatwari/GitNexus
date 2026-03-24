class PublicService {
    func doWork() {}
}

func internalHelper() -> String {
    return "help"
}

private func secretHelper() -> String {
    return "secret"
}

fileprivate func fileOnlyHelper() -> String {
    return "fileonly"
}
