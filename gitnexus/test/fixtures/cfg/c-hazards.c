/* C CFG hazard fixture (#2195 U2). Exercises every modeled C control-flow
 * construct so the pipeline emits BasicBlock + CFG + REACHING_DEF + CDG. */

int straight_line(int a, int b) {
  int x = a + b;
  int y = x * 2;
  return y;
}

int if_else(int x) {
  int r;
  if (x > 0) {
    r = 1;
  } else {
    r = -1;
  }
  return r;
}

int while_loop(int n) {
  int i = 0;
  int sum = 0;
  while (i < n) {
    sum = sum + i;
    i++;
  }
  return sum;
}

int do_while_loop(int n) {
  int i = 0;
  int sum = 0;
  do {
    sum = sum + i;
    i++;
  } while (i < n);
  return sum;
}

int for_loop(int n) {
  int sum = 0;
  for (int i = 0; i < n; i++) {
    sum = sum + i;
  }
  return sum;
}

const char *switch_fallthrough(int code) {
  const char *msg;
  switch (code) {
    case 1:
      msg = "one";
    case 2:
      msg = "two-or-more";
      break;
    default:
      msg = "other";
  }
  return msg;
}

int goto_jump(int n) {
  int i = 0;
  int sum = 0;
loop:
  if (i >= n) goto end;
  sum = sum + i;
  i++;
  goto loop;
end:
  return sum;
}

/* Non-terminating loop: EXIT must stay reverse-reachable for the CDG pass. */
void server_forever(void) {
  for (;;) {
    handle_request();
  }
}

int may_def(int a) {
  int x = 0;
  if (a && (x = compute())) {
    use(x);
  }
  return x;
}
