       01 WS-CUSTOMER-DATA.
           05 WS-CUST-CODE         PIC X(10).
           05 WS-CUST-TYPE         PIC X(3).
               88 PREMIUM-CUSTOMER VALUE 'PRM'.
               88 REGULAR-CUSTOMER VALUE 'REG'.
           05 WS-CUST-ADDR         PIC X(50).
