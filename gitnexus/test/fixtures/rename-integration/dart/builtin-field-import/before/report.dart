class Report {
  int value = 0;
}
int read(Report report) => report.value;
void write(Report report, int value) { report.value = value; }
String label = 'value';
