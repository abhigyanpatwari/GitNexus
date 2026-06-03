       IDENTIFICATION DIVISION.
       PROGRAM-ID. AUDITLOG.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-LOG-MESSAGE           PIC X(80).
       01 WS-TIMESTAMP             PIC X(26).
       01 WS-IDX                   PIC 9(4).
       01 WS-EOF-FLAG              PIC 9 VALUE 0.
       01 WS-PARAM-A               PIC X(10).
       01 WS-PARAM-B               PIC X(10).
       01 WS-PARAM-C               PIC X(10).
       01 WS-INDEX                 PIC 9(2).
       01 WS-FLAG                  PIC 9.
           COPY AUDITCONST.
           COPY AUDITVARS.

       LINKAGE SECTION.
       01 LS-CUST-ID               PIC 9(8).
       01 LS-AMOUNT                PIC 9(7)V99.

       PROCEDURE DIVISION USING LS-CUST-ID LS-AMOUNT.
       MAIN-PARAGRAPH.
           PERFORM WRITE-LOG
           PERFORM VARYING-TEST
           PERFORM UNTIL-TEST
           GOBACK.

       WRITE-LOG.
           STRING 'Customer ' LS-CUST-ID ' amount ' LS-AMOUNT
               DELIMITED BY SIZE INTO WS-LOG-MESSAGE
           DISPLAY WS-LOG-MESSAGE.

      * PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10
       VARYING-TEST.
           PERFORM VARYING WS-IDX FROM 1 BY 1
               UNTIL WS-IDX > 10
               DISPLAY 'COUNT ' WS-IDX
           END-PERFORM.

      * PERFORM UNTIL EOF-FLAG = 1
       UNTIL-TEST.
           PERFORM UNTIL WS-EOF-FLAG = 1
               DISPLAY 'LOOPING'
           END-PERFORM.

      * CALL with OMITTED (3 args: WS-PARAM-A, OMITTED, WS-PARAM-C)
       CALL-OMITTED-TEST.
           CALL 'PROCESS' USING WS-PARAM-A OMITTED WS-PARAM-C.

      * Nested IF with CALL inside
       NESTED-IF-CALL.
           IF WS-FLAG = 1
               IF WS-INDEX > 5
                   CALL 'DEEPPROC'
               ELSE
                   CALL 'SHALLOW'
               END-IF
           END-IF.

      * GO TO DEPENDING ON with 3 targets
       GOTO-DEPENDING.
           GO TO PARA-ONE PARA-TWO PARA-THREE
               DEPENDING ON WS-INDEX.

       PARA-ONE.
           DISPLAY 'ONE'.

       PARA-TWO.
           DISPLAY 'TWO'.

       PARA-THREE.
           DISPLAY 'THREE'.

       ENTRY "AUDITLOG-BATCH" USING LS-CUST-ID.
           DISPLAY 'Batch audit for ' LS-CUST-ID
           GOBACK.
