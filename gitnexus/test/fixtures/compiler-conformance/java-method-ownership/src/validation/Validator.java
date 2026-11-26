
interface Validator {
  boolean validate(Object input);
  String getMessage();
}

class EmailValidator {
  public boolean validate(Object input) { return true; }
  public String getMessage() { return "invalid email"; }
  private boolean checkFormat(String email) { return true; }
}
