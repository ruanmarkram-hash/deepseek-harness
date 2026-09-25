#include <stddef.h>
#include <stdint.h>

int dsh_chacha_encrypt(uint8_t *out, unsigned long long *out_len, const uint8_t *message, unsigned long long message_len, const uint8_t *aad, unsigned long long aad_len, const uint8_t nonce[12], const uint8_t key[32]);
int dsh_chacha_decrypt(uint8_t *out, unsigned long long *out_len, const uint8_t *ciphertext, unsigned long long ciphertext_len, const uint8_t *aad, unsigned long long aad_len, const uint8_t nonce[12], const uint8_t key[32]);
void dsh_secure_zero(void *value, size_t length);
