interface Named { String label(); }
enum Status implements Named {
  ACTIVE;
  public String label() { return "active"; }
}
