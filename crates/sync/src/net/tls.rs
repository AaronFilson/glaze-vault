//! TLS with raw public keys (RFC 7250): each side shows its Ed25519 key, with no X.509 at all.
//! A computer accepts only the host key it pinned; the host accepts any key that proves itself,
//! and decides by the key what the connection may do.

use rustls::DigitallySignedStruct;
use rustls::SignatureScheme;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{AlwaysResolvesClientRawPublicKeys, ClientConfig};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature_with_raw_key};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{AlwaysResolvesServerRawPublicKeys, ServerConfig};
use rustls::sign::CertifiedKey;
use rustls::{DistinguishedName, Error as TlsError, version::TLS13};
use std::sync::Arc;
use zeroize::Zeroizing;

/// An Ed25519 SubjectPublicKeyInfo, up to the key itself.
const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/// An Ed25519 PKCS #8 v1 private key, up to the seed.
const PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The name a computer gives in its hello. It is never checked: the pinned key is.
pub(crate) fn server_name() -> ServerName<'static> {
    ServerName::try_from("glaze-vault.invalid").expect("a valid name")
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn spki(public: &[u8]) -> Vec<u8> {
    [&SPKI_PREFIX[..], public].concat()
}

/// The Ed25519 key in a raw public key, if that is what it is.
pub(crate) fn key_of(der: &[u8]) -> Option<Vec<u8>> {
    let key = der.strip_prefix(&SPKI_PREFIX[..])?;
    (key.len() == 32).then(|| key.to_vec())
}

fn certified(seed: &[u8; 32]) -> Result<Arc<CertifiedKey>, TlsError> {
    let signing = ed25519_public(seed);
    let pkcs8 = Zeroizing::new([&PKCS8_PREFIX[..], seed].concat());
    let key = rustls::crypto::ring::sign::any_eddsa_type(&PrivatePkcs8KeyDer::from(pkcs8.as_slice()))?;
    Ok(Arc::new(CertifiedKey::new(
        vec![CertificateDer::from(spki(&signing))],
        key,
    )))
}

fn ed25519_public(seed: &[u8; 32]) -> Vec<u8> {
    ed25519_dalek::SigningKey::from_bytes(seed)
        .verifying_key()
        .to_bytes()
        .to_vec()
}

fn verify(
    algorithms: &WebPkiSupportedAlgorithms,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    verify_tls13_signature_with_raw_key(message, &SubjectPublicKeyInfoDer::from(cert.as_ref()), dss, algorithms)
}

/// The host's side: its key from `seed`, TLS 1.3 only, and a key from every computer.
pub fn server_config(seed: &[u8; 32]) -> Result<ServerConfig, TlsError> {
    let provider = provider();
    let verifier = Arc::new(AnyKey(provider.signature_verification_algorithms));
    Ok(ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])?
        .with_client_cert_verifier(verifier)
        .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(certified(seed)?))))
}

/// A computer's side: its key from `seed`, and the host's key it pinned. With no pin, as when
/// pairing, any host key is taken; the pairing's confirmation is what proves it.
pub fn client_config(seed: &[u8; 32], pin: Option<Vec<u8>>) -> Result<ClientConfig, TlsError> {
    let provider = provider();
    let verifier = Arc::new(PinnedHost {
        pin,
        algorithms: provider.signature_verification_algorithms,
    });
    Ok(ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(certified(seed)?))))
}

#[derive(Debug)]
struct PinnedHost {
    pin: Option<Vec<u8>>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedHost {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let key = key_of(end_entity).ok_or(TlsError::InvalidCertificate(rustls::CertificateError::BadEncoding))?;
        match &self.pin {
            Some(pin) if *pin != key => Err(TlsError::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            )),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::PeerIncompatible(
            rustls::PeerIncompatible::Tls13RequiredForQuic,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify(&self.algorithms, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

/// Takes any Ed25519 key that signs the handshake: the server looks the key up afterwards.
#[derive(Debug)]
struct AnyKey(WebPkiSupportedAlgorithms);

impl ClientCertVerifier for AnyKey {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        key_of(end_entity)
            .map(|_| ClientCertVerified::assertion())
            .ok_or(TlsError::InvalidCertificate(rustls::CertificateError::BadEncoding))
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::PeerIncompatible(
            rustls::PeerIncompatible::Tls13RequiredForQuic,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify(&self.0, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}
