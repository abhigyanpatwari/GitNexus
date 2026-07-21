script {
    use scripts_demo::treasury;

    fun sweep(admin: &signer) {
        treasury::sweep_all(admin);
    }
}
