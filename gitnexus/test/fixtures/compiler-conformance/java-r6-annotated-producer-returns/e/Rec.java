package e;
record Rec(User @Mark [] users) { void callRecord() { users()[0].save(); } }
