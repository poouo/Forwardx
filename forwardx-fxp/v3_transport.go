package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/poouo/Forwardx/forwardx-fxp/internal/v3"
)

// V3 wraps the existing authenticated FXP protocol; it never replaces its
// direction-separated encryption, replay defense, quotas, or business hello.
// No legacy connection is auto-detected or upgraded to a V3 transport.
func validateTransportConfig(cfg config) error {
	switch cfg.TransportVersion {
	case "", "v1", "v2":
		if cfg.V3Transport != "" || cfg.V3Host != "" || cfg.V3Path != "" || cfg.V3UserAgent != "" || cfg.V3ServerName != "" || cfg.V3Multiplex != nil {
			return errors.New("V3 options require transportVersion v3")
		}
		return nil
	case "v3":
	default:
		return fmt.Errorf("unsupported transportVersion %q", cfg.TransportVersion)
	}
	switch cfg.V3Transport {
	case "http", "ws":
		_, err := v3.HTTPRequest(cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3Transport == "ws", "")
		return err
	case "tls":
		if len(cfg.V3ServerName) > 253 || strings.ContainsAny(cfg.V3ServerName, "\x00\r\n\t /\\") {
			return errors.New("invalid V3 TLS server name")
		}
		return nil
	default:
		return fmt.Errorf("V3 requires http, ws, or tls transport, got %q", cfg.V3Transport)
	}
}

func v3MuxEnabled(cfg config) bool {
	return cfg.TransportVersion == "v3" && (cfg.V3Multiplex == nil || *cfg.V3Multiplex)
}

func wrapV3Client(conn net.Conn, cfg config) (net.Conn, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.TransportVersion != "v3" {
		return conn, nil
	}
	if cfg.V3Transport != "tls" {
		return v3.HTTPClient(conn, cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3Transport == "ws")
	}
	name := cfg.V3ServerName
	if name == "" {
		name = "forwardx.invalid"
	}
	public := v3CertificateKey(cfg.Key).Public().(ed25519.PublicKey)
	wrapped := tls.Client(conn, &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: name,
		NextProtos: []string{"http/1.1"},
		// The certificate is self-signed, but never blindly trusted. Its public
		// key is pinned to a domain-separated derivation of the tunnel PSK.
		// The existing FXP authenticated handshake runs inside TLS as well.
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 {
				return errors.New("v3: unexpected TLS certificate chain")
			}
			peer, ok := state.PeerCertificates[0].PublicKey.(ed25519.PublicKey)
			if !ok || !bytes.Equal(peer, public) {
				return errors.New("v3: TLS tunnel certificate pin mismatch")
			}
			return nil
		},
	})
	if err := wrapped.Handshake(); err != nil {
		return nil, err
	}
	return wrapped, nil
}

func wrapV3Server(conn net.Conn, cfg config) (net.Conn, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.TransportVersion != "v3" {
		return conn, nil
	}
	if cfg.V3Transport != "tls" {
		return v3.HTTPServer(conn, cfg.V3Host, cfg.V3Path, cfg.V3Transport == "ws")
	}
	cert, err := v3Certificate(cfg.Key)
	if err != nil {
		return nil, err
	}
	wrapped := tls.Server(conn, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"http/1.1"},
		Certificates: []tls.Certificate{cert},
	})
	if err := wrapped.Handshake(); err != nil {
		return nil, err
	}
	return wrapped, nil
}

func v3CertificateKey(key string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("forwardx-v3 outer TLS certificate\x00" + key))
	return ed25519.NewKeyFromSeed(seed[:])
}

var v3Certificates = struct {
	sync.Mutex
	items map[[32]byte]tls.Certificate
}{items: make(map[[32]byte]tls.Certificate)}

func v3Certificate(key string) (tls.Certificate, error) {
	cacheKey := sha256.Sum256([]byte(key))
	v3Certificates.Lock()
	defer v3Certificates.Unlock()
	if cert, ok := v3Certificates.items[cacheKey]; ok {
		return cert, nil
	}
	private := v3CertificateKey(key)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{CommonName: "ForwardX V3"},
		NotBefore:    time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2120, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, private.Public(), private)
	if err != nil {
		return tls.Certificate{}, err
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private}
	// Bound retained certificates independently of rule/tunnel churn.
	if len(v3Certificates.items) >= 64 {
		for entry := range v3Certificates.items {
			delete(v3Certificates.items, entry)
			break
		}
	}
	v3Certificates.items[cacheKey] = cert
	return cert, nil
}
