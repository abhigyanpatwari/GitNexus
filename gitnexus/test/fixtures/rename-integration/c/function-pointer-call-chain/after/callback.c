int calculate(int value) { return value + 1; }
int through_pointer(int value) {
    int (*operation)(int) = calculate;
    return operation(value);
}
int direct(int value) { return calculate(value); }
int outer(int value) { return direct(value) + through_pointer(value); }
const char *label = "compute";
// compute is also a first-class function pointer value.
