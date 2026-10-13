class Profile {
    String displayBadge = "badge";
}
class Account {
    Profile profile = Profile();
}
class Session {
    Account account = Account();
}
String read(Session session) { return session.account.profile.displayBadge; }
void update(Session session, String badge) { session.account.profile.displayBadge = badge; }
String direct(Profile profile) { return profile.displayBadge; }
class OtherProfile {
    String badge = "badge";
    String read(OtherProfile other) { return other.badge; }
}
// badge is public, not this comment
