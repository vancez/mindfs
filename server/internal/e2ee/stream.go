package e2ee

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	// StreamMagic prefixes every chunked AEAD stream.
	StreamMagic = "MFSC1"
	// StreamChunkSize is the maximum plaintext carried by one frame.
	StreamChunkSize = 1 << 20

	StreamPurposeUpload   = "upload"
	StreamPurposeDownload = "download"

	streamFrameNonceSize = 12
	streamTagSize        = 16
	streamFrameHeader    = 4 + 1 + streamFrameNonceSize
	streamFrameOverhead  = streamFrameHeader + streamTagSize
	streamFlagFinal      = 1 << 0
)

// ErrStreamInvalid is returned for malformed, truncated or tampered streams.
var ErrStreamInvalid = errors.New("e2ee stream invalid")

// EncryptedStreamLength returns the exact ciphertext size for plaintextSize
// bytes. The writer emits floor(n/StreamChunkSize) non-final frames plus one
// final frame (empty when n is an exact multiple).
func EncryptedStreamLength(plaintextSize int64) int64 {
	if plaintextSize < 0 {
		return 0
	}
	frames := plaintextSize/StreamChunkSize + 1
	return int64(len(StreamMagic)) + plaintextSize + frames*streamFrameOverhead
}

func newStreamAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func streamAAD(purpose, requestNonce string, index uint32, final bool) []byte {
	finalFlag := "0"
	if final {
		finalFlag = "1"
	}
	return []byte("mindfs-stream-v1\x1f" + purpose + "\x1f" + requestNonce + "\x1f" +
		strconv.FormatUint(uint64(index), 10) + "\x1f" + finalFlag)
}

func writeAll(w io.Writer, payload []byte) error {
	for len(payload) > 0 {
		n, err := w.Write(payload)
		if n > 0 {
			payload = payload[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// StreamWriter encrypts a plaintext byte stream as framed AES-GCM chunks.
type StreamWriter struct {
	w            io.Writer
	aead         cipher.AEAD
	purpose      string
	requestNonce string
	buf          []byte
	index        uint32
	magicWritten bool
	closed       bool
	err          error
}

// NewStreamWriter creates a writer using the purpose and request nonce as
// additional authenticated data. The purpose and nonce must match the reader.
func NewStreamWriter(w io.Writer, key []byte, purpose, requestNonce string) (*StreamWriter, error) {
	if w == nil {
		return nil, ErrStreamInvalid
	}
	if strings.TrimSpace(purpose) == "" || strings.TrimSpace(requestNonce) == "" {
		return nil, ErrStreamInvalid
	}
	aead, err := newStreamAEAD(key)
	if err != nil {
		return nil, err
	}
	return &StreamWriter{
		w:            w,
		aead:         aead,
		purpose:      purpose,
		requestNonce: requestNonce,
		buf:          make([]byte, 0, StreamChunkSize),
	}, nil
}

func (s *StreamWriter) ensureMagic() error {
	if s.magicWritten {
		return nil
	}
	if err := writeAll(s.w, []byte(StreamMagic)); err != nil {
		return err
	}
	s.magicWritten = true
	return nil
}

// Write buffers plaintext and flushes each full chunk as a non-final frame.
func (s *StreamWriter) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	if s.closed {
		return 0, ErrStreamInvalid
	}
	if err := s.ensureMagic(); err != nil {
		s.err = err
		return 0, err
	}
	written := 0
	for len(p) > 0 {
		space := StreamChunkSize - len(s.buf)
		n := len(p)
		if n > space {
			n = space
		}
		s.buf = append(s.buf, p[:n]...)
		p = p[n:]
		written += n
		if len(s.buf) == StreamChunkSize {
			if err := s.flush(false); err != nil {
				s.err = err
				return written, err
			}
		}
	}
	return written, nil
}

// Close emits the single final frame. Do not call it after a failed copy: the
// final frame would mark truncated data as complete.
func (s *StreamWriter) Close() error {
	if s.err != nil {
		return s.err
	}
	if s.closed {
		return nil
	}
	if err := s.ensureMagic(); err != nil {
		s.err = err
		return err
	}
	if err := s.flush(true); err != nil {
		s.err = err
		return err
	}
	s.closed = true
	return nil
}

func (s *StreamWriter) flush(final bool) error {
	plaintext := s.buf
	if !final && len(plaintext) == 0 {
		return fmt.Errorf("%w: empty non-final frame", ErrStreamInvalid)
	}
	frameNonce := make([]byte, streamFrameNonceSize)
	if _, err := rand.Read(frameNonce); err != nil {
		return err
	}
	aad := streamAAD(s.purpose, s.requestNonce, s.index, final)
	ciphertextLen := len(plaintext) + streamTagSize
	frame := make([]byte, streamFrameHeader+ciphertextLen)
	binary.BigEndian.PutUint32(frame[:4], uint32(ciphertextLen))
	if final {
		frame[4] = streamFlagFinal
	}
	copy(frame[5:streamFrameHeader], frameNonce)
	s.aead.Seal(frame[streamFrameHeader:streamFrameHeader], frameNonce, plaintext, aad)
	if err := writeAll(s.w, frame); err != nil {
		return err
	}
	s.buf = s.buf[:0]
	s.index++
	return nil
}

// StreamReader decrypts and validates a framed AES-GCM stream.
type StreamReader struct {
	r            *bufio.Reader
	aead         cipher.AEAD
	purpose      string
	requestNonce string
	index        uint32
	pending      []byte
	finalSeen    bool
	err          error
}

// NewStreamReader validates the stream magic and returns a decrypting reader.
func NewStreamReader(r io.Reader, key []byte, purpose, requestNonce string) (*StreamReader, error) {
	if r == nil {
		return nil, ErrStreamInvalid
	}
	if strings.TrimSpace(purpose) == "" || strings.TrimSpace(requestNonce) == "" {
		return nil, ErrStreamInvalid
	}
	aead, err := newStreamAEAD(key)
	if err != nil {
		return nil, err
	}
	reader := &StreamReader{
		r:            bufio.NewReader(r),
		aead:         aead,
		purpose:      purpose,
		requestNonce: requestNonce,
	}
	magic := make([]byte, len(StreamMagic))
	if _, err := io.ReadFull(reader.r, magic); err != nil {
		return nil, fmt.Errorf("%w: missing magic: %v", ErrStreamInvalid, err)
	}
	if string(magic) != StreamMagic {
		return nil, fmt.Errorf("%w: bad magic", ErrStreamInvalid)
	}
	return reader, nil
}

func (s *StreamReader) invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrStreamInvalid, fmt.Sprintf(format, args...))
}

func (s *StreamReader) nextFrame() error {
	header := make([]byte, streamFrameHeader)
	if _, err := io.ReadFull(s.r, header); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return s.invalid("truncated before final frame")
		}
		return err
	}
	ciphertextLen := int(binary.BigEndian.Uint32(header[:4]))
	flags := header[4]
	if flags&^streamFlagFinal != 0 {
		return s.invalid("unknown flags")
	}
	final := flags&streamFlagFinal != 0
	if ciphertextLen < streamTagSize || ciphertextLen > StreamChunkSize+streamTagSize {
		return s.invalid("invalid frame length")
	}
	if !final && ciphertextLen == streamTagSize {
		return s.invalid("empty non-final frame")
	}
	ciphertext := make([]byte, ciphertextLen)
	if _, err := io.ReadFull(s.r, ciphertext); err != nil {
		return s.invalid("truncated frame")
	}
	aad := streamAAD(s.purpose, s.requestNonce, s.index, final)
	plaintext, err := s.aead.Open(nil, header[5:streamFrameHeader], ciphertext, aad)
	if err != nil {
		return s.invalid("frame authentication failed")
	}
	s.index++
	if final {
		if _, err := s.r.Peek(1); err == nil {
			return s.invalid("trailing data after final frame")
		} else if !errors.Is(err, io.EOF) {
			return s.invalid("unreadable trailing data")
		}
		s.finalSeen = true
	}
	s.pending = plaintext
	return nil
}

// Read returns decrypted plaintext. It returns ErrStreamInvalid when the
// stream ends before a final frame is seen.
func (s *StreamReader) Read(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	if len(p) == 0 {
		return 0, nil
	}
	for len(s.pending) == 0 {
		if s.finalSeen {
			return 0, io.EOF
		}
		if err := s.nextFrame(); err != nil {
			s.err = err
			return 0, err
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

// Finish drains the stream and requires a clean final frame. It is idempotent.
func (s *StreamReader) Finish() error {
	if s.err != nil {
		return s.err
	}
	buf := make([]byte, 32<<10)
	for {
		_, err := s.Read(buf)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
