// A parameter that shadows a field masks the field for a bare read in its own
// body, whether or not a comment separates the signature from that body.
class Beta {
  void inner() {}
}

class Holder {
  var conn = Beta();

  void plain(conn) {
    conn.inner();
  }

  void commented(conn) /* the parameter is untyped */ {
    conn.inner();
  }
}
