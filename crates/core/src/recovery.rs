use crate::error::{Error, Result};
use bip39::Mnemonic;
use zeroize::Zeroizing;

/// 256 random bits, shown to the person once as 24 words (the BIP 39 English list, whose last
/// word carries a checksum, so a mistyped word is caught before any decryption is tried).
pub struct RecoveryKey(Mnemonic);

impl RecoveryKey {
    pub(crate) fn generate() -> Self {
        let entropy = Zeroizing::new(crate::crypto::random::<32>());
        RecoveryKey(Mnemonic::from_entropy(entropy.as_ref()).expect("32 bytes is a valid length"))
    }

    /// Accepts the words in any case, separated by any spaces or line breaks.
    pub fn parse(words: &str) -> Result<Self> {
        let normalized = Zeroizing::new(words.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase());
        let mnemonic = Mnemonic::parse_normalized(&normalized).map_err(|_| Error::WrongRecoveryKey)?;
        if mnemonic.word_count() != 24 {
            return Err(Error::WrongRecoveryKey);
        }
        Ok(RecoveryKey(mnemonic))
    }

    pub fn words(&self) -> Vec<String> {
        self.0.words().map(str::to_owned).collect()
    }

    pub(crate) fn entropy(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.0.to_entropy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_parse_back_loosely_but_checksum_is_checked() {
        let key = RecoveryKey::generate();
        let words = key.words();
        assert_eq!(words.len(), 24);
        let messy = format!("  {}\n", words.join("   ").to_uppercase());
        assert_eq!(*RecoveryKey::parse(&messy).unwrap().entropy(), *key.entropy());

        let mut wrong = words.clone();
        wrong.swap(0, 1);
        if wrong != words {
            assert!(RecoveryKey::parse(&wrong.join(" ")).is_err());
        }
        assert!(RecoveryKey::parse(&words[..12].join(" ")).is_err());
    }
}
