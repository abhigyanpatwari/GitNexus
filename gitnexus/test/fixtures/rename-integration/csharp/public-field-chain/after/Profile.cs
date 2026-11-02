class Profile {
    public string DisplayBadge = "Badge";
}
class Account {
    public Profile Profile;
}
class Session {
    public Account Account;
}
class Dashboard {
    public string Read(Session session) { return session.Account.Profile.DisplayBadge; }
    public void Update(Session session, string Badge) { session.Account.Profile.DisplayBadge = Badge; }
    public string Direct(Profile profile) { return profile.DisplayBadge; }
    // Badge is a public field, not this comment
}
class OtherProfile {
    public string Badge = "Badge";
    public string Read(OtherProfile other) { return other.Badge; }
}
