#include <stddef.h>

int crypto_aead_chacha20poly1305_ietf_encrypt(unsigned char *ciphertext, unsigned long long *ciphertext_length, const unsigned char *message, unsigned long long message_length, const unsigned char *authenticated_data, unsigned long long authenticated_data_length, const unsigned char *secret_nonce, const unsigned char *public_nonce, const unsigned char *key);
int crypto_aead_chacha20poly1305_ietf_decrypt(unsigned char *message, unsigned long long *message_length, unsigned char *secret_nonce, const unsigned char *ciphertext, unsigned long long ciphertext_length, const unsigned char *authenticated_data, unsigned long long authenticated_data_length, const unsigned char *public_nonce, const unsigned char *key);
void sodium_memzero(void *value, size_t length);
