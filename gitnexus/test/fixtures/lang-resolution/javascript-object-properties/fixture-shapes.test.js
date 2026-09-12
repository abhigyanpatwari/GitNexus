// A TEST file that constructs a throwaway shape with a production field name.
// Measured on the reporting repo: four of seven JavaScript anchors for one
// field lived in `tests/`, competing with the three real ones and making every
// production read ambiguous. A read in production cannot mean any of these.
export function buildTestFixture() {
  return {
    productionAndTestField: 'fixture',
  };
}
