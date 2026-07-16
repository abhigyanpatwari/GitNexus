script {
    use scripts_demo::treasury;

    fun airdrop(admin: &signer, recipient: address, amount: u64) {
        treasury::pay(admin, recipient, amount);
    }
}
