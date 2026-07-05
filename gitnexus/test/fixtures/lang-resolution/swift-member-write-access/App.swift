func transfer(acct: Account) {
    acct.owner = "alice"
}

func inspect(acct: Account) -> String {
    let who = acct.owner
    return who
}
