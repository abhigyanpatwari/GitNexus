      *****************************************************************
      * DECLARATIVES + USE AFTER STANDARD ERROR.
      *
      * `cobol-processor.ts` turns each DECLARATIVES handler into an
      * ACCESSES edge from the handler SECTION's `Namespace` node to a
      * synthesized `Record` node for the file the USE clause names --
      * the `Namespace -> Record` FROM/TO pair. Both endpoints are
      * structural (neither label is in `LINKABLE_LABELS`), so no
      * scope-bridge cross product reaches it.
      *****************************************************************
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ERRDEMO.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT CUSTOMER-FILE ASSIGN TO "CUST.DAT"
               ORGANIZATION IS SEQUENTIAL.
           SELECT AUDIT-FILE ASSIGN TO "AUDIT.DAT"
               ORGANIZATION IS SEQUENTIAL.
       DATA DIVISION.
       FILE SECTION.
       FD  CUSTOMER-FILE.
       01  CUSTOMER-REC.
           05  CUST-ID        PIC X(10).
           05  CUST-BALANCE   PIC 9(7)V99.
       FD  AUDIT-FILE.
       01  AUDIT-REC.
           05  AUDIT-TEXT     PIC X(60).
       WORKING-STORAGE SECTION.
       01  WS-EOF             PIC X VALUE "N".
       PROCEDURE DIVISION.
       DECLARATIVES.
       CUSTOMER-ERR-HANDLER SECTION.
           USE AFTER STANDARD ERROR ON CUSTOMER-FILE.
       CUSTOMER-ERR-PARA.
           DISPLAY "CUSTOMER IO ERROR".
       AUDIT-ERR-HANDLER SECTION.
           USE AFTER STANDARD ERROR ON AUDIT-FILE.
       AUDIT-ERR-PARA.
           DISPLAY "AUDIT IO ERROR".
       END DECLARATIVES.
       MAIN-SECTION SECTION.
       MAIN-PARA.
           OPEN INPUT CUSTOMER-FILE
           OPEN OUTPUT AUDIT-FILE
           CLOSE CUSTOMER-FILE
           CLOSE AUDIT-FILE
           STOP RUN.
