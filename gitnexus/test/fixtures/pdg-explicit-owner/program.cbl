>>SOURCE FORMAT FREE
identification division.
program-id. Outer.
data division.
working-storage section.
01 OUTER-TOTAL PIC 9.
01 OUTER-FLAG PIC 9.
procedure division.
main.
    move 0 to OUTER-TOTAL
    if OUTER-FLAG = 1
        move 1 to OUTER-TOTAL
        display OUTER-TOTAL
    end-if
    display OUTER-TOTAL
    goback.
identification division.
program-id. Inner.
data division.
working-storage section.
01 INNER-TOTAL PIC 9.
01 INNER-FLAG PIC 9.
procedure division.
inner-main.
    move 0 to INNER-TOTAL
    if INNER-FLAG = 1
        move 2 to INNER-TOTAL
        display INNER-TOTAL
    end-if
    display INNER-TOTAL
    goback.
end program Inner.
end program Outer.
