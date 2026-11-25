
class Logger {
  public void info(String msg) {}
  public void error(String msg) {}
}

class Formatter {
  public String format(String template) { return template; }
  private String escape(String input) { return input; }
}
