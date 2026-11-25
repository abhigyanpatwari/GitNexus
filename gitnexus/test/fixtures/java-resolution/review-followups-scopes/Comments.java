class Comments {
  void parameter(User // element type continues below
      [] values) { values[0].save(); }
  void local() {
    User // element type continues below
      [] values = null;
    values[0].save();
  }
}