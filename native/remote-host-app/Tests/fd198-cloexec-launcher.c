#include <unistd.h>

int main(int argc, char *argv[]) {
  if (argc < 2) return 64;
  int descriptors[2];
  if (pipe(descriptors) != 0) return 65;
  if (dup2(descriptors[0], 198) != 198) return 66;
  close(descriptors[0]);
  close(descriptors[1]);
  execv(argv[1], &argv[1]);
  return 67;
}
