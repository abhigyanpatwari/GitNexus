class Profile {
    var badge: String = "badge"
}
class Account {
    lateinit var profile: Profile
}
class Session {
    lateinit var account: Account
}
fun read(session: Session): String { return session.account.profile.badge }
fun update(session: Session, badge: String) { session.account.profile.badge = badge }
fun direct(profile: Profile): String { return profile.badge }
class OtherProfile {
    var badge: String = "badge"
    fun read(other: OtherProfile): String { return other.badge }
}
// badge is public; this comment is unchanged
