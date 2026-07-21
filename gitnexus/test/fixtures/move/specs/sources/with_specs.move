module spec_demo::vault {
    struct Vault has key {
        balance: u64
    }

    public fun deposit(account: &signer, addr: address, amount: u64) acquires Vault {
        if (!exists<Vault>(addr)) {
            move_to(account, Vault { balance: 0 });
        };
        let v = borrow_global_mut<Vault>(addr);
        v.balance = v.balance + amount;
    }

    public fun withdraw(addr: address, amount: u64): u64 acquires Vault {
        let v = borrow_global_mut<Vault>(addr);
        v.balance = v.balance - amount;
        amount
    }

    spec module {
        pragma verify = true;
    }

    spec deposit {
        ensures global<Vault>(addr).balance
            == old(global<Vault>(addr).balance) + amount;
    }

    spec withdraw {
        aborts_if global<Vault>(addr).balance < amount;
    }

    spec schema BalancePositive {
        addr: address;
        ensures global<Vault>(addr).balance >= 0;
    }
}
