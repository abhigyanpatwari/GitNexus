       IDENTIFICATION DIVISION.
       PROGRAM-ID. MULTISQL.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-DATA PIC X(100).
       PROCEDURE DIVISION.
           EXEC SQL
               SELECT A.CUST_NAME, B.ACCT_BAL
               FROM CUSTOMER C, ACCOUNT A
               WHERE C.CUST_ID = A.CUST_ID
           END-EXEC.
           EXEC SQL
               SELECT *
               FROM CUSTOMER, ACCOUNT
               WHERE CUSTOMER.ID = ACCOUNT.CUST_ID
           END-EXEC.
           EXEC SQL
               SELECT *
               FROM INVENTORY
               WHERE QTY > 0
           END-EXEC.
           STOP RUN.
       END PROGRAM MULTISQL.
