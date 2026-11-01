//! Verifies the Ed25519 signatures that tools/publish.mjs and tools/sync-r2.mjs
//! put beside catalog.json and every manifest.json. The public key is compiled
//! in from src-tauri/signing.pub (written by `npm run keygen`); the private key
//! never leaves the developer's machine. Anything that doesn't verify is refused,
//! so a compromised server or bucket cannot push files to players.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// Base64 of the raw 32-byte public key.
pub const EMBEDDED_PUBLIC_KEY: &str = include_str!("../signing.pub");

#[derive(Debug, thiserror::Error)]
pub enum SigError {
    #[error("the launcher's built-in signing key is invalid")]
    BadKey,
    #[error("signature file is malformed")]
    BadSignature,
    #[error("signature check failed — the file was not signed with this launcher's publisher key")]
    Mismatch,
}

pub fn verify(public_key_b64: &str, bytes: &[u8], signature_b64: &str) -> Result<(), SigError> {
    let pk = B64.decode(public_key_b64.trim()).map_err(|_| SigError::BadKey)?;
    let pk: [u8; 32] = pk.try_into().map_err(|_| SigError::BadKey)?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| SigError::BadKey)?;
    let sig = B64.decode(signature_b64.trim()).map_err(|_| SigError::BadSignature)?;
    let sig = Signature::from_slice(&sig).map_err(|_| SigError::BadSignature)?;
    vk.verify(bytes, &sig).map_err(|_| SigError::Mismatch)
}

#[cfg(test)]
pub mod testkey {
    //! A throwaway key pair for tests, so the test suite can sign the sample
    //! game itself instead of depending on the developer's real key.
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use ed25519_dalek::{Signer, SigningKey};

    pub fn generate() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        (sk.clone(), B64.encode(sk.verifying_key().to_bytes()))
    }
    pub fn sign(sk: &SigningKey, bytes: &[u8]) -> String {
        B64.encode(sk.sign(bytes).to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_and_rejects() {
        let (sk, pk) = testkey::generate();
        let data = b"{\"gameId\":\"x\"}";
        let sig = testkey::sign(&sk, data);
        assert!(verify(&pk, data, &sig).is_ok());
        assert!(matches!(verify(&pk, b"{\"gameId\":\"y\"}", &sig), Err(SigError::Mismatch)));
        assert!(matches!(verify("AAAA", data, &sig), Err(SigError::BadKey)));
        assert!(matches!(verify(&pk, data, "not-base64!"), Err(SigError::BadSignature)));
    }
}
