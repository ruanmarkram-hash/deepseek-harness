#include <errno.h>
#include <fcntl.h>

int main(void) {
  return fcntl(198, F_GETFD) == -1 && errno == EBADF ? 0 : 1;
}
