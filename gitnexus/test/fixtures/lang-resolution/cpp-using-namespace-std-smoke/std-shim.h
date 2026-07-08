#pragma once

// Fixture-local std-shaped namespace. Captures the wildcard-leak shape
// without depending on real system-header modeling. The names mirror
// common STL identifiers (cout_write, println) so a regression that
// re-introduces unqualified std:: binding shows up in the assertions
// below — without us having to control whether GitNexus parses real
// system headers.

namespace std {
  void cout_write();
  void println();
}
