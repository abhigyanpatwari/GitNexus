class Account {
    var balance: Int = 0
    var owner: String = ""

    init(start: Int) {
        self.balance = start
    }

    func deposit(amount: Int) {
        self.balance = amount
    }

    func readBalance() -> Int {
        let current = self.balance
        return current
    }
}
