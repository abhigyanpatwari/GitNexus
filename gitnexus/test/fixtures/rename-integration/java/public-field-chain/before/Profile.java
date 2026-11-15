class Profile {
    public String badge = "badge";
}
class Account {
    public Profile profile;
}
class Session {
    public Account account;
}
class Dashboard {
    String read(Session session) { return session.account.profile.badge; }
    void update(Session session, String badge) { session.account.profile.badge = badge; }
    String direct(Profile profile) { return profile.badge; }
    // badge is a public API field, not this comment
}
class OtherProfile {
    public String badge = "badge";
    String read(OtherProfile other) { return other.badge; }
}
