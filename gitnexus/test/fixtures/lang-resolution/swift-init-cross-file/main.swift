func main() {
    let user = User.init(name: "alice")
    user.save()
    user.greet()
}
