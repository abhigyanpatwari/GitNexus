class Profile {
    public var badge: String = "badge"
}
class Account {
    var profile: Profile = Profile()
}
class Session {
    var account: Account = Account()
}
func read(session: Session) -> String { return session.account.profile.badge }
func update(session: Session, badge: String) { session.account.profile.badge = badge }
func direct(profile: Profile) -> String { return profile.badge }
class OtherProfile {
    public var badge: String = "badge"
    func read(other: OtherProfile) -> String { return other.badge }
}
// badge is a stored property, not this comment
