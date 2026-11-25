package client;

class Present {}
class MemberOwner { public static class Present {} }

class ParameterRoot<T, U extends MemberOwner> {
    class MissingMember extends T.Present {}
    class BoundMember extends U.Present {}
}

class Container {
    static class MemberOwner { static class Present {} }
    static class Derived<V extends MemberOwner> {
        class NestedBound extends V.Present {}
    }
}
