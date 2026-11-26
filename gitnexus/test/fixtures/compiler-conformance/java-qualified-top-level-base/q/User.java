package q;
class Base { public void ping() {} }
class User extends p.Base { void use() { this.ping(); } }
