#include <unistd.h>

int main(void) {
  static const unsigned char ready[] = { 0, 0, 0, 3, 1, 0, 0 };
  (void)write(198, ready, sizeof(ready) - 1);
  return 0;
}
