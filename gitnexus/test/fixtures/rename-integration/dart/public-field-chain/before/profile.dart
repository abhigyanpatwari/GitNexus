class Profile {
    String badge = "badge";
}
class Account {
    Profile profile = Profile();
}
class Session {
    Account account = Account();
}
String read(Session session) { return session.account.profile.badge; }
void update(Session session, String badge) { session.account.profile.badge = badge; }
String direct(Profile profile) { return profile.badge; }
class OtherProfile {
    String badge = "badge";
    String read(OtherProfile other) { return other.badge; }
}
// badge is public, not this comment
