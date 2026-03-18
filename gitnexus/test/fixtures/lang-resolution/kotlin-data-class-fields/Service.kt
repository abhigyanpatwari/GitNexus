fun processUser(user: User) {
    // Field-access chain: user.address → Address, then .save() → Address#save
    user.address.save()
}
