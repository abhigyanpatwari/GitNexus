       IDENTIFICATION DIVISION.
       PROGRAM-ID. RPTGEN.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY CUSTDAT.
       01 WS-REPORT-LINE           PIC X(132).
       01 WS-SQL-CODE              PIC S9(9) COMP.
       01 WS-COUNT                 PIC 9(4).
       01 WS-MAP-NAME              PIC X(8).
       01 WS-SORT-FILE             PIC X(8).
       01 WS-QUEUE-NAME            PIC X(16).
       01 WS-NEXT-PGM              PIC X(8).

       PROCEDURE DIVISION.
       MAIN-PARAGRAPH.
           PERFORM FETCH-DATA
           PERFORM FORMAT-REPORT
           PERFORM SEND-SCREEN
           CALL "CUSTUPDT"
           GO TO EXIT-PARAGRAPH.

       FETCH-DATA.
           EXEC SQL
               SELECT CUST_NAME, CUST_BALANCE
               FROM CUSTOMER
               WHERE CUST_ID = :WS-CUST-CODE
           END-EXEC.

       FORMAT-REPORT.
           PERFORM WS-COUNT TIMES
               MOVE WS-CUST-CODE TO WS-REPORT-LINE
           END-PERFORM
           PERFORM MAIN-PARAGRAPH THRU FORMAT-REPORT
           IF WS-COUNT > 0 PERFORM FETCH-DATA
                      ELSE PERFORM SEND-SCREEN
           END-IF
           SORT WS-SORT-FILE USING CUSTOMER-DATA
               GIVING WS-REPORT-LINE.
           SORT WS-SORT-FILE ON ASCENDING KEY WS-COUNT
               INPUT PROCEDURE IS BUILD-SORT-INPUT
               OUTPUT PROCEDURE IS WRITE-SORTED.
           MOVE CORR WS-CUSTOMER-DATA TO WS-REPORT-LINE
           SEARCH WS-CUSTOMER-DATA
           GO TO FETCH-DATA FORMAT-REPORT SEND-SCREEN
               DEPENDING ON WS-COUNT.

       SEND-SCREEN.
           EXEC CICS
               SEND MAP(WS-MAP-NAME) MAPSET('CUSTSET')
               FROM(WS-REPORT-LINE)
           END-EXEC.

           EXEC CICS
               LINK PROGRAM('AUDITLOG')
           END-EXEC.

           EXEC CICS
               XCTL PROGRAM('CUSTUPDT')
           END-EXEC.

           EXEC CICS
               READ FILE('CUSTFILE')
               INTO(WS-CUSTOMER-DATA)
           END-EXEC.

           EXEC CICS
               WRITEQ TS QUEUE('RPTQUEUE')
               FROM(WS-REPORT-LINE)
           END-EXEC.

           EXEC CICS
               HANDLE ABEND LABEL(ABEND-HANDLER)
           END-EXEC.

           EXEC CICS
               RETURN TRANSID('RPTG')
           END-EXEC.

           EXEC CICS
               XCTL PROGRAM(WS-NEXT-PGM)
           END-EXEC.

       BUILD-SORT-INPUT.
           DISPLAY 'BUILDING SORT INPUT'.

       WRITE-SORTED.
           DISPLAY 'WRITING SORTED OUTPUT'.

       ABEND-HANDLER.
           DISPLAY 'ABEND OCCURRED'.

       EXIT-PARAGRAPH.
           STOP RUN.
