       IDENTIFICATION DIVISION.
       PROGRAM-ID. MALFORMED.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PGM   PIC X(8) VALUE "OTHER".
       PROCEDURE DIVISION.
       MAIN.
      * Incomplete statement (no period)
           MOVE "TEST" TO WS-PGM
      * CALL USING on separate lines
           CALL "TARGET"
               USING WS-PGM
               RETURNING WS-PGM
      * CALL without END-CALL across lines
           CALL "MULTILINE"
               USING WS-PGM
      * GO TO with multiple targets
           GO TO MAIN EXIT-PARA.
       EXIT-PARA.
           GOBACK.
