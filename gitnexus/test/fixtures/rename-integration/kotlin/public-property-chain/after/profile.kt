class Profile {
    var displayBadge: String = "badge"
}
class Account {
    lateinit var profile: Profile
}
class Session {
    lateinit var account: Account
}
fun read(session: Session): String { return session.account.profile.displayBadge }
fun update(session: Session, badge: String) { session.account.profile.displayBadge = badge }
fun direct(profile: Profile): String { return profile.displayBadge }
class OtherProfile {
    var badge: String = "badge"
    fun read(other: OtherProfile): String { return other.badge }
}
// badge is public; this comment is unchanged
