fun updateUser(user: User) {
    user.name = "Alice"
    user.address = Address()
    // Compound assignment — tree-sitter-kotlin uses `assignment` node for both
    user.score += 10
}
