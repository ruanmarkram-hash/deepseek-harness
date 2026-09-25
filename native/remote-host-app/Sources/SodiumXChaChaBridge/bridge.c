#include "libsodium-minimal.h"
#include "SodiumXChaChaBridge.h"

int dsh_chacha_encrypt(uint8_t *out, unsigned long long *out_len, const uint8_t *message, unsigned long long message_len, const uint8_t *aad, unsigned long long aad_len, const uint8_t nonce[12], const uint8_t key[32]) {
  return crypto_aead_chacha20poly1305_ietf_encrypt(out, out_len, message, message_len, aad, aad_len, NULL, nonce, key);
}

int dsh_chacha_decrypt(uint8_t *out, unsigned long long *out_len, const uint8_t *ciphertext, unsigned long long ciphertext_len, const uint8_t *aad, unsigned long long aad_len, const uint8_t nonce[12], const uint8_t key[32]) {
  return crypto_aead_chacha20poly1305_ietf_decrypt(out, out_len, NULL, ciphertext, ciphertext_len, aad, aad_len, nonce, key);
}

void dsh_secure_zero(void *value, size_t length) { sodium_memzero(value, length); }
