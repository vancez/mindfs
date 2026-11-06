package e2ee

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
)

const (
	WSFrameClientToServer = "c2s"
	WSFrameServerToClient = "s2c"
)

func buildTransportProof(key []byte, label string, parts ...string) string {
	h := hmac.New(sha256.New, key)
	sum := sha256.Sum256([]byte(joinParts(label, parts...)))
	_, _ = h.Write(sum[:])
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// RequestEnvelopeAAD binds an encrypted JSON request body to the proof context.
func RequestEnvelopeAAD(method, path, nonce string) []byte {
	return []byte(joinParts("mindfs-envelope-v1", "request", method, path, nonce))
}

// ResponseEnvelopeAAD binds an encrypted JSON response body to the request that
// produced it. A relay cannot move a valid response envelope to another request.
func ResponseEnvelopeAAD(method, path, nonce string) []byte {
	return []byte(joinParts("mindfs-envelope-v1", "response", method, path, nonce))
}

// WSAAD binds a WebSocket frame to its direction and position in the stream.
func WSAAD(direction string, sequence uint64) []byte {
	return []byte(joinParts("mindfs-ws-frame-v1", direction, strconv.FormatUint(sequence, 10)))
}

// BuildStreamMetadataProof authenticates the HTTP metadata served alongside an
// encrypted raw-download stream.
func BuildStreamMetadataProof(key []byte, method, path, nonce, contentType, contentLength, contentDisposition, streamMarker string) string {
	return buildTransportProof(
		key,
		"mindfs-stream-meta-v1",
		method,
		path,
		nonce,
		contentType,
		contentLength,
		contentDisposition,
		streamMarker,
	)
}
