class Profile {
    public String displayBadge = "badge";
}
class Account {
    public Profile profile;
}
class Session {
    public Account account;
}
class Dashboard {
    String read(Session session) { return session.account.profile.displayBadge; }
    void update(Session session, String badge) { session.account.profile.displayBadge = badge; }
    String direct(Profile profile) { return profile.displayBadge; }
    // badge is a public API field, not this comment
}
class OtherProfile {
    public String badge = "badge";
    String read(OtherProfile other) { return other.badge; }
}
