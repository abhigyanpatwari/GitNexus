       IDENTIFICATION DIVISION.
       PROGRAM-ID. PERFTIMS.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-COUNT PIC 9(03) VALUE 5.
       01 WS-DONE PIC X(01).
       PROCEDURE DIVISION.
       1000-START.
           PERFORM 2000-PROCESS.
           PERFORM 2000-PROCESS THRU 2100-CLEANUP.
      *    PERFORM TIMES with inline count — not a paragraph call:
           PERFORM 2000-PROCESS 3 TIMES.
      *    PERFORM TIMES with identifier — not a paragraph call:
           PERFORM 2000-PROCESS WS-COUNT TIMES.
      *    PERFORM VARYING — not a paragraph call:
           PERFORM VARYING WS-COUNT FROM 1 BY 1 UNTIL WS-COUNT > 10
               CONTINUE
           END-PERFORM.
           GO TO 9000-END.
       2000-PROCESS.
           MOVE 'X' TO WS-DONE.
       2100-CLEANUP.
           MOVE 'Y' TO WS-DONE.
       9000-END.
           STOP RUN.
       END PROGRAM PERFTIMS.
